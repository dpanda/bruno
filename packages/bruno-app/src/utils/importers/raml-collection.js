import jsyaml from 'js-yaml';
import each from 'lodash/each';
import get from 'lodash/get';
import fileDialog from 'file-dialog';
import { uuid } from 'utils/common';
import { BrunoError } from 'utils/common/error';
import { validateSchema, transformItemsInCollection, hydrateSeqInCollection } from './common';

const readFile = (files) => {
  return new Promise((resolve, reject) => {
    const fileReader = new FileReader();
    fileReader.onload = (e) => {
      try {
        let IncludeYamlType = new jsyaml.Type('!include', { kind: 'scalar' });
        let INCLUDE_SCHEMA = jsyaml.Schema.create([IncludeYamlType]);
        const parsedData = jsyaml.safeLoad(e.target.result, { schema: INCLUDE_SCHEMA });
        resolve(parsedData);
      } catch (yamlError) {
        console.error('Error parsing the file :', yamlError);
        reject(new BrunoError('Import collection failed'));
      }
    };
    fileReader.onerror = (err) => reject(err);
    fileReader.readAsText(files[0]);
  });
};

const ensureUrl = (url) => {
  // replace any double or triple slashes
  return url.replace(/([^:]\/)\/+/g, '$1');
};

const ensureUriParameter = (uriParam) => {
  return uriParam.replaceAll('{', '{{').replaceAll('}', '}}');
};

const extractUriParameters = (path) => {
  return path
    .split('/')
    .filter((s) => s.startsWith('{'))
    .filter((s) => s !== '{{baseUri}}')
    .map((s) => {
      return {
        uid: uuid(),
        name: s,
        value: '',
        local: false,
        enabled: true
      };
    });
};

const buildApiName = (method, path) => {
  return method.toUpperCase() + ' ' + path.replaceAll('/', ' ').replaceAll('{', ' ').replaceAll('}', ' ').trim();
};

const buildEmptyJsonBody = (bodySchema) => {
  let _jsonBody = {};
  each(bodySchema.properties || {}, (prop, name) => {
    if (prop.type === 'object') {
      _jsonBody[name] = buildEmptyJsonBody(prop);
      // handle arrays
    } else if (prop.type === 'array') {
      _jsonBody[name] = [];
    } else {
      _jsonBody[name] = '';
    }
  });
  return _jsonBody;
};

const createBrunoRequest = (method, baseUri, path, properties) => {
  console.log(method + ' ' + path);
  const brunoRequestItem = {
    uid: uuid(),
    name: properties.displayName || buildApiName(method, path),
    type: 'http-request',
    request: {
      url: ensureUrl(baseUri + '/' + path),
      method: method.toUpperCase(),
      auth: {
        mode: 'none',
        basic: null,
        bearer: null,
        digest: null
      },
      headers: [],
      params: [],
      vars: {
        req: extractUriParameters(path) || []
      },
      body: {
        mode: 'none',
        json: null,
        text: null,
        xml: null,
        formUrlEncoded: [],
        multipartForm: []
      },
      docs: properties.description || ''
    }
  };

  console.log(brunoRequestItem.request.vars);

  Object.entries(properties.queryParameters || {}).map(([param, paramProperties]) =>
    brunoRequestItem.request.params.push({
      uid: uuid(),
      name: param,
      value: '',
      description: paramProperties.description || '',
      enabled: paramProperties.required
    })
  );

  Object.entries(properties.headers || {}).map(([header, headerProperties]) =>
    brunoRequestItem.request.headers.push({
      uid: uuid(),
      name: header,
      value: headerProperties.example || '',
      description: headerProperties.description || '',
      enabled: headerProperties.required
    })
  );

  return brunoRequestItem;
};

const createBrunoFolder = (path) => {
  return {
    uid: uuid(),
    name: path.replaceAll('/', ' '),
    type: 'folder',
    items: []
  };
};

const transformRamlNode = (entries, baseUri, basePath, currentFolder) => {
  const reserved = [
    'title',
    'protocols',
    'mediatype',
    'resourcetypes',
    'traits',
    'types',
    'type',
    'uriparameters',
    'headers'
  ];
  const methods = ['get', 'patch', 'post', 'delete', 'put', 'options', 'head', 'trace'];

  // TODO support headers specified not at api level but in parent node (cannot filter out reserved keywords)

  let brunoEntries = Object.entries(entries)
    //.filter(([key, val]) => !reserved.includes(key.toLowerCase()))
    .map(([key, val]) => {
      if (methods.includes(key.toLowerCase())) {
        return createBrunoRequest(key, baseUri, basePath, val || {});
      } else if (key.startsWith('/')) {
        let folder = createBrunoFolder(key);
        return transformRamlNode(val, baseUri, basePath + ensureUriParameter(key), folder);
      }
      return [];
    })
    .reduce((acc, val) => acc.concat(val), []); // flatten;

  if (currentFolder) {
    currentFolder.items = brunoEntries;
    return currentFolder;
  } else {
    return brunoEntries;
  }
};

const transformOpenapiRequestItem = (request) => {
  let _operationObject = request.operationObject;

  let operationName = _operationObject.operationId || _operationObject.summary || _operationObject.description;
  if (!operationName) {
    operationName = `${request.method} ${request.path}`;
  }

  const brunoRequestItem = {
    uid: uuid(),
    name: operationName,
    type: 'http-request',
    request: {
      url: ensureUrl(request.global.server + '/' + request.path),
      method: request.method.toUpperCase(),
      auth: {
        mode: 'none',
        basic: null,
        bearer: null,
        digest: null
      },
      headers: [],
      params: [],
      body: {
        mode: 'none',
        json: null,
        text: null,
        xml: null,
        formUrlEncoded: [],
        multipartForm: []
      }
    }
  };

  each(_operationObject.parameters || [], (param) => {
    if (param.in === 'query') {
      brunoRequestItem.request.params.push({
        uid: uuid(),
        name: param.name,
        value: '',
        description: param.description || '',
        enabled: param.required
      });
    } else if (param.in === 'header') {
      brunoRequestItem.request.headers.push({
        uid: uuid(),
        name: param.name,
        value: '',
        description: param.description || '',
        enabled: param.required
      });
    }
  });

  let auth;
  // allow operation override
  if (_operationObject.security && _operationObject.security.length > 0) {
    let schemeName = Object.keys(_operationObject.security[0])[0];
    auth = request.global.security.getScheme(schemeName);
  } else if (request.global.security.supported.length > 0) {
    auth = request.global.security.supported[0];
  }

  if (auth) {
    if (auth.type === 'http' && auth.scheme === 'basic') {
      brunoRequestItem.request.auth.mode = 'basic';
      brunoRequestItem.request.auth.basic = {
        username: '{{username}}',
        password: '{{password}}'
      };
    } else if (auth.type === 'http' && auth.scheme === 'bearer') {
      brunoRequestItem.request.auth.mode = 'bearer';
      brunoRequestItem.request.auth.bearer = {
        token: '{{token}}'
      };
    } else if (auth.type === 'apiKey' && auth.in === 'header') {
      brunoRequestItem.request.headers.push({
        uid: uuid(),
        name: auth.name,
        value: '{{apiKey}}',
        description: 'Authentication header',
        enabled: true
      });
    }
  }

  // TODO: handle allOf/anyOf/oneOf
  if (_operationObject.requestBody) {
    let content = get(_operationObject, 'requestBody.content', {});
    let mimeType = Object.keys(content)[0];
    let body = content[mimeType] || {};
    let bodySchema = body.schema;
    if (mimeType === 'application/json') {
      brunoRequestItem.request.body.mode = 'json';
      if (bodySchema && bodySchema.type === 'object') {
        let _jsonBody = buildEmptyJsonBody(bodySchema);
        brunoRequestItem.request.body.json = JSON.stringify(_jsonBody, null, 2);
      }
    } else if (mimeType === 'application/x-www-form-urlencoded') {
      brunoRequestItem.request.body.mode = 'formUrlEncoded';
      if (bodySchema && bodySchema.type === 'object') {
        each(bodySchema.properties || {}, (prop, name) => {
          brunoRequestItem.request.body.formUrlEncoded.push({
            uid: uuid(),
            name: name,
            value: '',
            description: prop.description || '',
            enabled: true
          });
        });
      }
    } else if (mimeType === 'multipart/form-data') {
      brunoRequestItem.request.body.mode = 'multipartForm';
      if (bodySchema && bodySchema.type === 'object') {
        each(bodySchema.properties || {}, (prop, name) => {
          brunoRequestItem.request.body.multipartForm.push({
            uid: uuid(),
            name: name,
            value: '',
            description: prop.description || '',
            enabled: true
          });
        });
      }
    } else if (mimeType === 'text/plain') {
      brunoRequestItem.request.body.mode = 'text';
      brunoRequestItem.request.body.text = '';
    } else if (mimeType === 'text/xml') {
      brunoRequestItem.request.body.mode = 'xml';
      brunoRequestItem.request.body.xml = '';
    }
  }

  return brunoRequestItem;
};

const resolveRefs = (spec, components = spec.components) => {
  if (!spec || typeof spec !== 'object') {
    return spec;
  }

  if (Array.isArray(spec)) {
    return spec.map((item) => resolveRefs(item, components));
  }

  if ('$ref' in spec) {
    const refPath = spec.$ref;

    if (refPath.startsWith('#/components/')) {
      // Local reference within components
      const refKeys = refPath.replace('#/components/', '').split('/');
      let ref = components;

      for (const key of refKeys) {
        if (ref[key]) {
          ref = ref[key];
        } else {
          // Handle invalid references gracefully?
          return spec;
        }
      }

      return resolveRefs(ref, components);
    } else {
      // Handle external references (not implemented here)
      // You would need to fetch the external reference and resolve it.
      // Example: Fetch and resolve an external reference from a URL.
    }
  }

  // Recursively resolve references in nested objects
  for (const prop in spec) {
    spec[prop] = resolveRefs(spec[prop], components);
  }

  return spec;
};

const groupRequestsByTags = (requests) => {
  let _groups = {};
  let ungrouped = [];
  each(requests, (request) => {
    let tags = request.operationObject.tags || [];
    if (tags.length > 0) {
      let tag = tags[0]; // take first tag
      if (!_groups[tag]) {
        _groups[tag] = [];
      }
      _groups[tag].push(request);
    } else {
      ungrouped.push(request);
    }
  });

  let groups = Object.keys(_groups).map((groupName) => {
    return {
      name: groupName,
      requests: _groups[groupName]
    };
  });

  return [groups, ungrouped];
};

const getDefaultUrl = (serverObject) => {
  let url = serverObject.url;
  if (serverObject.variables) {
    each(serverObject.variables, (variable, variableName) => {
      let sub = variable.default || (variable.enum ? variable.enum[0] : `{{${variableName}}}`);
      url = url.replace(`{${variableName}}`, sub);
    });
  }
  return url;
};

const getSecurity = (apiSpec) => {
  let supportedSchemes = apiSpec.security || [];
  if (supportedSchemes.length === 0) {
    return {
      supported: []
    };
  }

  let securitySchemes = get(apiSpec, 'components.securitySchemes', {});
  if (Object.keys(securitySchemes) === 0) {
    return {
      supported: []
    };
  }

  return {
    supported: supportedSchemes.map((scheme) => {
      var schemeName = Object.keys(scheme)[0];
      return securitySchemes[schemeName];
    }),
    schemes: securitySchemes,
    getScheme: (schemeName) => {
      return securitySchemes[schemeName];
    }
  };
};

const parseRamlCollection = (data) => {
  return new Promise((resolve, reject) => {
    try {
      console.log(data);

      let baseUri = data['baseUri'] || '{{baseUri}}';

      const brunoCollection = {
        name: data.title || '',
        uid: uuid(),
        version: '1',
        items: transformRamlNode(data, baseUri, ''),
        environments: []
      };
      resolve(brunoCollection);

      /*
      const collectionData = resolveRefs(data);
      if (!collectionData) {
        reject(new BrunoError('Invalid Raml collection. Failed to resolve refs.'));
        return;
      }

      // Currently parsing of openapi spec is "do your best", that is
      // allows "invalid" openapi spec

      // assumes v3 if not defined. v2 no supported yet
      if (collectionData.openapi && !collectionData.openapi.startsWith('3')) {
        reject(new BrunoError('Only OpenAPI v3 is supported currently.'));
        return;
      }

      // TODO what if info.title not defined?
      brunoCollection.name = collectionData.info.title;
      let servers = collectionData.servers || [];
      let baseUrl = servers[0] ? getDefaultUrl(servers[0]) : '';
      let securityConfig = getSecurity(collectionData);

      let allRequests = Object.entries(collectionData.paths)
        .map(([path, methods]) => {
          return Object.entries(methods)
            .filter(([method, op]) => {
              return ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(
                method.toLowerCase()
              );
            })
            .map(([method, operationObject]) => {
              return {
                method: method,
                path: path,
                operationObject: operationObject,
                global: {
                  server: baseUrl,
                  security: securityConfig
                }
              };
            });
        })
        .reduce((acc, val) => acc.concat(val), []); // flatten

      let [groups, ungroupedRequests] = groupRequestsByTags(allRequests);
      let brunoFolders = groups.map((group) => {
        return {
          uid: uuid(),
          name: group.name,
          type: 'folder',
          items: group.requests.map(transformOpenapiRequestItem)
        };
      });

      let ungroupedItems = ungroupedRequests.map(transformOpenapiRequestItem);
      let brunoCollectionItems = brunoFolders.concat(ungroupedItems);
      brunoCollection.items = brunoCollectionItems;
      resolve(brunoCollection);
      */
      //console.log(brunoCollection);
      //throw new Error('Not implemented');
    } catch (err) {
      console.error(err);
      reject(new BrunoError('An error occurred while parsing the RAML collection'));
    }
  });
};

const importCollection = () => {
  return new Promise((resolve, reject) => {
    fileDialog({ accept: '.raml, .yaml, .yml, application/yaml, application/x-yaml' })
      .then(readFile)
      .then(parseRamlCollection)
      .then(transformItemsInCollection)
      .then(hydrateSeqInCollection)
      .then(validateSchema)
      .then((collection) => resolve(collection))
      .catch((err) => {
        console.error(err);
        reject(new BrunoError('Import collection failed: ' + err.message));
      });
  });
};

export default importCollection;
