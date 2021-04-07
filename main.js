const ja = require('jsonata');
const iconv = require('iconv-lite');

module.exports.templateTags = [
  {
    name: 'jsonata_response',
    displayName: 'jsonata_response',
    description: "reference values from other request's responses -JSONpath -Xpath +JSONata filter",
    args: [
      {
        displayName: 'Request',
        type: 'model',
        model: 'Request',
      },
      {
        displayName: 'JSONata expression',
        type: 'string',
        encoding: 'base64',
      },
      {
        displayName: 'Trigger Behavior',
        help: 'Configure when to resend the dependent request',
        type: 'enum',
        options: [
          {
            displayName: 'Never',
            description: 'never resend request',
            value: 'never',
          },
          {
            displayName: 'No History',
            description: 'resend when no responses present',
            value: 'no-history',
          },
          {
            displayName: 'Always',
            description: 'resend request when needed',
            value: 'always',
          },
        ],
      },
    ],

    async run(context, id, filter, resendBehavior) {
      filter = filter || '';
      resendBehavior = (resendBehavior || 'never').toLowerCase();

      if (!id) {
        throw new Error('No request specified');
      }

      const request = await context.util.models.request.getById(id);
      if (!request) {
        throw new Error(`Could not find request ${id}`);
      }

      let response = await context.util.models.response.getLatestForRequestId(id);

      let shouldResend = false;
      if (context.context.getExtraInfo('fromResponseTag')) {
        shouldResend = false;
      } else if (resendBehavior === 'never') {
        shouldResend = false;
      } else if (resendBehavior === 'no-history') {
        shouldResend = !response;
      } else if (resendBehavior === 'always') {
        shouldResend = true;
      }

      // Make sure we only send the request once per render so we don't have infinite recursion
      const fromResponseTag = context.context.getExtraInfo('fromResponseTag');
      if (fromResponseTag) {
        console.log('[response tag] Preventing recursive render');
        shouldResend = false;
      }

      if (shouldResend && context.renderPurpose === 'send') {
        console.log('[response tag] Resending dependency');
        response = await context.network.sendRequest(request, [
          { name: 'fromResponseTag', value: true },
        ]);
      }

      if (!response) {
        console.log('[response tag] No response found');
        throw new Error('No responses for request');
      }

      if (response.error) {
        console.log('[response tag] Response error ' + response.error);
        throw new Error('Failed to send dependent request ' + response.error);
      }

      if (!response.statusCode) {
        console.log('[response tag] Invalid status code ' + response.statusCode);
        throw new Error('No successful responses for request');
      }

      if (!filter) {
        throw new Error(`No filter specified`);
      }

      const sanitizedFilter = filter.trim();

      const bodyBuffer = context.util.models.response.getBodyBuffer(response, '');
      const match = response.contentType.match(/charset=([\w-]+)/);
      const charset = match && match.length >= 2 ? match[1] : 'utf-8';

      // Sometimes iconv conversion fails so fallback to regular buffer
      let body;
      try {
          body = iconv.decode(bodyBuffer, charset);
      } catch (err) {
          body = bodyBuffer.toString();
          console.warn('[response] Failed to decode body', err);
      }

      return matchJSONata(body, sanitizedFilter);

    },
  },
];

function matchJSONata(bodyStr, query) {
  let body;
  let results;
  let exp;

  try {
    body = JSON.parse(bodyStr);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }

  try {
    exp = ja(query);
  } catch (err) {
    throw new Error(`Invalid JSONata expression: ${query}`);
  }

  try {
    results = exp.evaluate(body);
  } catch (err) {
    throw new Error(`Invalid JSONata response: ${query}`);
  }

  if (typeof results !== 'string') {
    return JSON.stringify(results);
  } else {
    return JSON.parse(JSON.stringify(results)); //mad way to dequote the string
  }
}