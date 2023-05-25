import fs from 'node:fs'
import { isArray } from 'lodash-es'
import type { Components, Info, Path, PropertiesValue, SwaggerSchema } from './types'
import { request_session_template } from './pythonTemplate'
import { APIS_FILE_NAME, COMPONENTS_FILE_NAME, ENUMS_FILE_NAME, PYTHON_REQUEST_SESSION_FILE_NAME } from './enum'

export enum PropertiesType {
  INTEGER = 'integer',
  STRING = 'string',
  NUMBER = 'number',
  ARRAY = 'array',
  BOOLEAN = 'boolean',
  OBJECT = 'object',
  VOID = 'Void',
}

export function generatePythonCode(schema: SwaggerSchema, output?: string) {
  const { components, paths } = schema
  generatePythonClass(components, output)
  generateApi(paths, output)
}

const typeMap = {
  [PropertiesType.INTEGER]: 'int',
  [PropertiesType.NUMBER]: 'int',
  [PropertiesType.STRING]: 'str',
  [PropertiesType.ARRAY]: 'list',
  [PropertiesType.BOOLEAN]: 'bool',
  [PropertiesType.OBJECT]: 'dict',
  [PropertiesType.VOID]: 'None',
}

const generic_components: Record<string, any> = {}

// 传进来是一个类名 如 "GenericPageQueryResult«List«BusinessVoucherInfo»»"
function get_generic_class_list(str: string) {
  str = str.replaceAll('»', '')
  const class_list = str.split('«')
  return class_list
}

function get_sub_generic_class(str: string) {
  const list = get_generic_class_list(str)
  if (list.length === 1)
    return list[0]
}

// 判断是否是泛型属性
function is_generic_property(v: PropertiesValue, class_name: string) {
  const ref = v.$ref ?? v.items?.$ref
  if (ref) {
    const ref_type = get$RefType(ref)
    return class_name.includes(ref_type)
  }

  return class_name.includes(v.type)
}

// 获取泛型属性的类名例如：list[T]
function get_generic_property_class(v: PropertiesValue, generic_name: string) {
  if (v.type === PropertiesType.ARRAY)
    return `list[${generic_name}]`

  return generic_name
}

function get$RefType(str: string) {
  const sp = str.split('/')
  return sp[sp.length - 1]
}

function getRefType(ref: string) {
  const sp = ref.split('/')
  return `${drop_generics(sp[sp.length - 1])}`
}

function drop_generics(str: string) {
  const sp = str.split('«')
  // 返回泛型
  return `${sp[0]}`
}

function get_generic_class(str: string) {
  const sp = str.split('«')
  // 返回泛型
  if (!sp[1])
    return sp[0]
  return `${sp[1].replace('»', '')}`
}

function getRealClass(ref: string) {
  const sp = ref.split('/')
  return get_generic_class(`${sp[sp.length - 1]}`)
}

function isGeneric(ref: string) {
  return ref.includes('«') || ref.includes('[')
}

function format_generic_type(type: string) {
  const ref_type = get$RefType(type)

  if (isGeneric(type)) {
    const class_types = get_generic_class_list(ref_type)

    const first = class_types.shift()
    const filter_types = class_types.filter(v => v !== 'List')
    const g_class = filter_types.reduce((pre, cur) => {
      if (cur === 'List')
        return pre
      return `${pre}[${`${typeMap[cur] ?? `${COMPONENTS_FILE_NAME}.${cur}`}`}`
    }, `${COMPONENTS_FILE_NAME}.${first}`)

    return g_class + new Array(filter_types.length).fill(']').join('')

    // const g_class = get_generic_class(type)
    // const i = type.indexOf('«')
    // const root_class = type.substring(0, i)
    // return `${root_class}[${typeMap[g_class] ?? `${COMPONENTS_FILE_NAME}.${g_class}`}]`
  }

  return typeMap[type] ?? `${COMPONENTS_FILE_NAME}.${ref_type}`
}

function format_generic_response(type: string) {
  const ref_type = get$RefType(type)
  const class_types = get_generic_class_list(ref_type)
  const keys = ['resp']
  let response_str = ''

  let is_List = false
  for (let i = 0; i < class_types.length; i++) {
    const class_str = class_types[i]
    let next_class_str = class_types[i + 1]
    const generic_property_key = generic_components[class_str]?.generic_property_key

    if (class_str === 'List')
      continue

    if (next_class_str === 'List') {
      next_class_str = class_types[i + 2]
      is_List = true
    }

    if (generic_property_key) {
      keys.push(generic_property_key)
      const k = keys.join('.')

      if (is_List) {
        is_List = false
        response_str += `${k} = [${COMPONENTS_FILE_NAME}.${next_class_str}(**v) for v in ${k}]\n    `
      }
      else { response_str += `${k} = ${COMPONENTS_FILE_NAME}.${next_class_str}(**${k})\n    ` }
    }
  }
  return response_str
}

const api_template = `
@provide_request_session
async def {api_name}({args}session: ClientSession = None):
    async with session.{method} as response:
        data = await response.{parse}
    {response_type}

    `
function generateApi(paths: Path, output?: string) {
  const api_str_list: string[] = []
  Object.keys(paths).forEach((k) => {
    const method_obj = paths[k]
    Object.keys(method_obj).forEach((l) => {
      let t = api_template

      const method = l
      // 设置方法名称
      const { description, operationId, parameters, requestBody, responses } = method_obj[l]
      t = t.replace('{api_name}', operationId)

      if (parameters && isArray(parameters)) {
        const args_list: string[] = []
        const json_args_list: string[] = []
        parameters.forEach((e) => {
          const { schema, required } = e

          const python_type = schema.$ref ? getRefType(schema.$ref) : typeMap[schema.type]
          // 格式化参数
          args_list.push(`${e.name}: ${python_type} ${required ? '' : '=None'}`)
          json_args_list.push(`'${e.name}':${e.name}`)
        })
        const args_str = args_list.join(', ')
        const json_args_str = json_args_list.join(',')
        // 设置参数
        t = t.replace('{args}', `${args_str}, `)
        t = t.replace('{method}', `${method}('${k}',json={${json_args_str}})`)
      }
      //  请求参数是对象
      else if (requestBody) {
        // 获取对象 class
        const $ref = requestBody.content['application/json'].schema.$ref
        const python_type = format_generic_type($ref)
        // 设置参数
        t = t.replace('{args}', `data: ${python_type}, `)
        t = t.replace('{method}', `${method}('${k}',json=data.dict())`)
      }
      else {
        t = t.replace('{args}', '')
        t = t.replace('{method}', `${method}('${k}')`)
      }

      let response_type = ''
      const return_none = () => {
        return t.replace('{response_type}', response_type ? `return ${response_type}.parse_obj(data)` : 'return data')
      }
      if (responses) {
        const content_type_k = Object.keys(responses['200'].content)[0]
        const { schema } = responses['200'].content[content_type_k]
        const $ref = schema.$ref
        if ($ref) {
          response_type = format_generic_type($ref)
          // parse to pydantic class
          const real_class = getRealClass($ref)
          if (!typeMap[real_class] && isGeneric($ref))
            t = t.replace('{response_type}', response_type ? `resp = ${response_type}.parse_obj(data)\n    ${format_generic_response($ref)}\n    return resp` : 'None')
          else
            t = return_none()
        }
        else {
          t = return_none()
        }
      }
      else {
        t = return_none()
      }

      t = t.replace('{parse}', 'json()')
      t = `${description ? `''' ${description} '''` : ''}${t}`
      api_str_list.push(t)
    })
  })

  const session_file = `${output ?? '.'}/${PYTHON_REQUEST_SESSION_FILE_NAME}.py`

  // 首次才生成
  if (!fs.existsSync(session_file))
    fs.writeFileSync(session_file, request_session_template)
  const imports = ['""" This file is automatically generated, please do not modify """', 'from .request_session import provide_request_session', `from . import ${COMPONENTS_FILE_NAME}`, 'from aiohttp import ClientSession']
  fs.writeFileSync(`${output ?? '.'}/${APIS_FILE_NAME}.py`, [...imports, api_str_list.join('\n\n')].join('\n\n'))
}

// 生成对应的模型
function generatePythonClass(components: Components, output?: string) {
  const components_list: string[] = []
  // 泛型个数
  let generic_count = 0
  const { schemas } = components
  Object.keys(schemas).forEach((k) => {
    const { properties, description: class_description } = schemas[k]

    const getType = (v: PropertiesValue, class_name?: string) => {
      const { type, $ref, items } = v
      let python_type = $ref ? getRefType($ref) : typeMap[type]
      if (items && python_type === 'list') {
        const list_type = getType(items, class_name)
        python_type = `list[${list_type}]`
      }

      return class_name === python_type ? `'${python_type}'` : python_type
    }

    // 是否是泛型
    const is_generic_class = isGeneric(k)

    const generic_type = `T${generic_count}`
    const define_generic = `${generic_type} = TypeVar("${generic_type}")`
    const class_name = drop_generics(k)

    // 生成枚举, key 写死后期可能开放
    if (class_name === 'AllEnumsInfo')
      return generate_python_enums(schemas[k], output)

    // 已经存在的泛型就跳过
    if (generic_components[class_name])
      return

    let class_name_str = `${class_description ? `""" ${class_description} """\n` : ''}class ${class_name}(${is_generic_class ? `Generic[${generic_type}], ` : ''}BaseModel):`

    if (is_generic_class) {
      generic_components[class_name] = { class_name }
      class_name_str = `${define_generic}\n${class_name_str}`
      generic_count++
    }

    const get_property = () => {
      return Object.keys(properties).map((p) => {
        const { description } = properties[p]
        let python_type = getType(properties[p], class_name)

        // console.log('python_type:', python_type)
        // console.log('get_generic_class(k):', get_generic_class(k))

        // 如果是泛型则设置泛型
        if (is_generic_class && is_generic_property(properties[p], k)) {
          generic_components[class_name].generic_property_key = p
          python_type = get_generic_property_class(properties[p], generic_type)
        }

        if (description) {
          const fill_description = description.split('\n').map(e => `\t\t# ${e.trim()}`).join('\n')
          return `${fill_description}\n\t\t${p}: ${python_type} = None`
        }

        return `\t\t${p}: ${python_type} = None`
      })
    }

    const properties_list: string[] = properties ? get_property() : ['\t\tpass']
    const final_class = [class_name_str, ...properties_list].join('\n')
    let has_push = false
    for (let i = 0; i < components_list.length; i++) {
      const e = components_list[i]
      if (e.includes(class_name)) {
        components_list.splice(i, 0, final_class)
        has_push = true
        break
      }
    }
    if (!has_push)
      components_list.push(final_class)
  })
  const imports = ['""" This file is automatically generated, please do not modify """', 'from pydantic import BaseModel', 'from typing import Generic, TypeVar']
  fs.writeFileSync(`${output ?? '.'}/${COMPONENTS_FILE_NAME}.py`, [...imports, components_list.join('\n\n')].join('\n\n'))
}

function generate_python_enums(all_enums_info: Info, output?: string) {
  const { properties } = all_enums_info
  if (properties) {
    const enums_list: string[] = []
    Object.keys(properties).forEach((k) => {
      const { enum: enum_list, description, example } = properties[k]
      const enum_name = example ?? k[0].toUpperCase() + k.slice(1)
      const enum_description = description
      const enum_str = [`${enum_description ? `""" ${enum_description} """\n` : ''}class ${enum_name}(str, Enum):`]
      enum_list.forEach((e: string) => {
        enum_str.push(`\t${e} = '${e}'`)
      })
      enums_list.push(enum_str.join('\n'))
    })

    const imports = ['""" This file is automatically generated, please do not modify """', 'from enum import Enum']
    fs.writeFileSync(`${output ?? '.'}/${ENUMS_FILE_NAME}.py`, [...imports, enums_list.join('\n\n')].join('\n\n'))
  }
}
