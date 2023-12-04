import jsyaml from 'js-yaml';
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

const createBrunoRequest = (method, baseUri, path, properties, defaultMediaType) => {
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

  if (properties.body) {
    let bodyModeMapping = {
      'multipart/form-data': 'multipartForm',
      'application/x-www-form-urlencoded': 'formUrlEncoded',
      'application/json': 'json',
      'application/xml': 'xml',
      'text/xml': 'xml',
      'text/plain': 'text'
    };

    var mediaType = Object.keys(bodyModeMapping).find((element) => properties.body[element]) || defaultMediaType;

    console.log('Media type ' + mediaType);

    if (mediaType) {
      let bodyMode = bodyModeMapping[mediaType];
      brunoRequestItem.request.body.mode = bodyMode;
      console.log('Body mode is ' + bodyMode);

      if (bodyMode === 'multipartForm' || bodyMode === 'formUrlEncoded') {
        let bodyProps = get(properties, 'body.mediaType.properties', properties.body.properties) || {};

        Object.entries(bodyProps).map(([field, fieldProp]) =>
          brunoRequestItem.request.body[bodyMode].push({
            uid: uuid(),
            name: field,
            value: '',
            description: fieldProp.description || '',
            enabled: fieldProp.required
          })
        );
      } else {
        let example = get(properties, 'body.mediaType.example', properties.body.example) || '';

        brunoRequestItem.request.body[bodyMode] = example;
      }
    }
  }
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

const transformRamlNode = (entries, baseUri, basePath, defaultMediaType, currentFolder) => {
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

  // TODO support headers specified not at api level but in parent node

  let brunoEntries = Object.entries(entries)
    .map(([key, val]) => {
      if (methods.includes(key.toLowerCase())) {
        return createBrunoRequest(key, baseUri, basePath, val || {}, defaultMediaType);
      } else if (key.startsWith('/')) {
        let folder = createBrunoFolder(key);
        return transformRamlNode(val, baseUri, basePath + ensureUriParameter(key), defaultMediaType, folder);
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

const parseRamlCollection = (data) => {
  return new Promise((resolve, reject) => {
    try {
      console.log(data);

      let baseUri = data['baseUri'] || '{{baseUri}}';
      let defaultMediaType = data['mediaType'];

      console.log('default media type is ' + defaultMediaType);

      const brunoCollection = {
        name: data.title || '',
        uid: uuid(),
        version: '1',
        items: transformRamlNode(data, baseUri, '', defaultMediaType),
        environments: []
      };
      resolve(brunoCollection);
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
