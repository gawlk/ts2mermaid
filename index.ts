import * as ts from 'typescript'
import * as fs from 'fs'
import * as path from 'path'
import { exec } from 'child_process'

type Options =
  | Configuration
  | Configuration[]
  | {
      global: Configuration
      list: Configuration[]
    }

interface Configuration {
  name?: string
  pathToScan?: string
  pathToSave?: string
  emptySavePath?: true
  hideTypes?: true
  hideInterfaces?: true
  hideDependencies?: true
  hideExtends?: true
  include?: RegExp[]
  exclude?: RegExp[]
}

interface Type {
  name: string
  value: string | Interface
  dependencies: string[]
  extends: string[]
}

interface Interface {
  [key: string]: string
}

const kindEnum = ts.SyntaxKind

const getTypesFromFilePath = (
  filePath: string,
  configuration?: Configuration
): Type[] => {
  const sourceFile = ts.createSourceFile(
    '',
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.ESNext
  )

  const types: Type[] = []

  const getTypescriptType = (node: ts.Node) =>
    node
      .getText(sourceFile)
      .replace(/\n/g, ' ')
      .split('')
      .map((letter: string) =>
        letter.match(/\(|\)|\{|\}|\<|\>/) ? `#${letter.charCodeAt(0)};` : letter
      )
      .join('')

  const getDependencies = (obj: any) => {
    const dependencies: string[] = []

    if (obj.kind !== kindEnum.FunctionType) {
      if (Array.isArray(obj)) {
        obj.forEach((childObj) =>
          dependencies.push(...getDependencies(childObj))
        )
      } else if (typeof obj === 'object') {
        Object.entries(obj).map(([key, value]) => {
          if (key === 'escapedText') {
            dependencies.push(value as string)
          } else if (key !== 'name' && typeof value === 'object') {
            dependencies.push(...getDependencies(value))
          }
        })
      }
    }

    return obj.kind === kindEnum.QualifiedName
      ? [dependencies.join('.')]
      : dependencies
  }

  const removeDuplicatesFromArray = (arr: any[]) => Array.from(new Set(arr))

  const getParameters = (childNode: any) =>
    childNode.typeParameters
      ? `~${(childNode as any).typeParameters.map(
          (parameter: any, index: number) =>
            `${index !== 0 ? ' ' : ''}${parameter.name.escapedText}`
        )}~`
      : ''

  sourceFile.forEachChild((childNode) => {
    const kind = childNode.kind

    if (
      kind !== kindEnum.InterfaceDeclaration &&
      kind !== kindEnum.TypeAliasDeclaration
    ) {
      return
    }

    const name = `${
      (childNode as any).name.escapedText as string
    }${getParameters(childNode)}`

    if (
      (!configuration?.include && !configuration?.exclude) ||
      (configuration?.include &&
        configuration?.include
          ?.map((regex) => !!name.match(regex))
          .includes(true)) ||
      (configuration?.exclude &&
        !configuration?.exclude
          ?.map((regex) => !!name.match(regex))
          .includes(true))
    ) {
      const type: Type = {
        name: name,
        value: '',
        dependencies: [] as string[],
        extends: [] as string[],
      }

      switch (kind) {
        case kindEnum.InterfaceDeclaration:
          if (configuration?.hideInterfaces) {
            return
          }

          type.extends.push(
            ...((
              childNode as ts.InterfaceDeclaration
            ).heritageClauses?.[0].types.map(
              (type) => (type.expression as any).escapedText
            ) || [])
          )

          const value = {} as Interface

          ;(childNode as ts.InterfaceDeclaration).members.forEach(
            (childNode) => {
              const childNodeType = (childNode as any).type as ts.TypeNode

              const childNodeName =
                childNode.kind === kindEnum.PropertySignature
                  ? `${(childNode as any).name.escapedText as string}${
                      childNode.questionToken ? '?' : ''
                    }`
                  : kindEnum.IndexSignature
                  ? `[${(childNode as any).parameters
                      .map((parameter: any) => parameter.getText(sourceFile))
                      .join(', ')}]`
                  : ''

              value[childNodeName] = getTypescriptType(childNodeType)

              type.dependencies.push(...getDependencies(childNodeType))
            }
          )

          type.value = value

          break

        default:
          if (configuration?.hideTypes) {
            return
          }

          const childNodeType = (childNode as any).type as ts.TypeNode

          type.value = getTypescriptType(childNodeType)

          type.dependencies.push(...getDependencies(childNodeType))
      }

      type.dependencies = removeDuplicatesFromArray(type.dependencies)

      types.push(type as Type)
    }
  })

  return types
}

const getTypesFromDirectoryPath = (
  pathToScan: string,
  configuration?: Configuration
): Type[] => {
  const types: Type[] = []

  if (fs.lstatSync(pathToScan).isDirectory()) {
    fs.readdirSync(pathToScan).map((fileName) => {
      const filePath = path.join(pathToScan, fileName)

      if (fs.lstatSync(filePath).isDirectory()) {
        types.push(...getTypesFromDirectoryPath(filePath, configuration))
      } else if (filePath.match(/\.tsx?$/)) {
        types.push(...getTypesFromFilePath(filePath, configuration))
      }
    })
  } else {
    types.push(...getTypesFromFilePath(pathToScan, configuration))
  }

  return types
}

const convertJSONTypesToMermaidTypes = (
  types: Type[],
  configuration?: Configuration
) => `classDiagram
${types
  .map((type) => {
    const isInterface = typeof type.value === 'object'

    return `class ${type.name} {
  <<${isInterface ? 'interface' : 'type'}>>
${
  isInterface
    ? Object.entries(type.value)
        .map(
          ([attribute, typescriptType]) => `  ${attribute}: ${typescriptType}`
        )
        .join('\n')
    : `  ${type.value}`
}
}
${
  configuration?.hideDependencies
    ? ''
    : convertDependenciesToMermaid(types, type)
}
${configuration?.hideExtends ? '' : convertExtendsToMermaid(types, type)}
`
  })
  .join('\n')}
`

const convertDependenciesToMermaid = (types: Type[], type: Type) =>
  (
    type.dependencies
      .map((dependency) =>
        types.find((type) => type.name.split('~')[0] === dependency)
      )
      .filter((type) => type) as Type[]
  )
    .map((dependencyType) => {
      let linkEnd = ''

      if (dependencyType.dependencies.includes(type.name)) {
        linkEnd = '<'

        dependencyType?.dependencies.splice(
          dependencyType?.dependencies.indexOf(type.name),
          1
        )
      }

      return `${type.name} <..${linkEnd} ${dependencyType.name}`
    })
    .join('\n')

const convertExtendsToMermaid = (types: Type[], type: Type) =>
  (
    type.extends
      .map((extendedName) => types.find((type) => type.name === extendedName))
      .filter((type) => type) as Type[]
  )
    .map((extendedType) => `${extendedType.name} <|-- ${type.name}`)
    .join('\n')

const execMermaid = (pathToMMD: string, pathToSvg: string) =>
  exec(
    `npx -p @mermaid-js/mermaid-cli mmdc -i ${pathToMMD} -o ${pathToSvg}`,
    (err) => err && console.error(`exec error: ${err}`)
  )

const processConfiguration = (
  pathToScan: string,
  pathToSave: string,
  fileName: string,
  configuration?: Configuration
) => {
  if (!fs.existsSync(pathToSave)) {
    fs.mkdirSync(pathToSave, { recursive: true })
  }

  const types = getTypesFromDirectoryPath(pathToScan, configuration)

  fs.writeFileSync(
    `${pathToSave}/${fileName}.json`,
    JSON.stringify(types, null, 2)
  )

  const pathToMMD = `${pathToSave}/${fileName}.mmd`

  fs.writeFileSync(
    pathToMMD,
    convertJSONTypesToMermaidTypes(types, configuration)
  )

  execMermaid(pathToMMD, `${pathToSave}/${fileName}.svg`)

  fs.writeFileSync(
    `${pathToSave}/${fileName}.md`,
    `![diagram](./${fileName}.svg)`
  )
}

const main = async (options?: Options) => {
  const defaultPathToScan = 'src'

  const defaultPathToSave = 'mermaid'

  const configurations =
    options && 'global' in options
      ? options.list
      : Array.isArray(options)
      ? options
      : null

  const configuration = configurations ? null : (options as Configuration)

  if (configurations) {
    const globalConfiguration =
      options && 'global' in options ? options.global : null

    let mainMDCreated = false

    configurations.forEach((configuration, index) => {
      configuration = {
        ...globalConfiguration,
        ...configuration,
      }

      processConfiguration(
        configuration.pathToScan || defaultPathToScan,
        path.join(
          configuration.pathToSave || defaultPathToSave,
          configuration.name || String(index + 1)
        ),
        'types',
        configuration
      )

      if (!configuration.pathToSave) {
        const pathToSave = globalConfiguration?.pathToSave || defaultPathToSave

        const pathToMainMD = `${pathToSave}/types.md`

        if (!mainMDCreated) {
          mainMDCreated = true

          fs.mkdirSync(pathToSave, { recursive: true })

          fs.writeFileSync(pathToMainMD, '')
        }

        fs.appendFileSync(
          pathToMainMD,
          `# ${configuration.name}

![${configuration.name}](./${configuration.name}/types.svg)

`
        )
      }
    })
  } else if (configuration) {
    processConfiguration(
      defaultPathToScan,
      defaultPathToSave,
      configuration?.name || 'types',
      configuration
    )
  }
}

export default main

export const viteTS2Mermaid = (options: Options) => {
  return {
    name: 'ts2mermaid',
    closeBundle() {
      main(options)
    },
  }
}

export const rollupTS2Mermaid = viteTS2Mermaid
