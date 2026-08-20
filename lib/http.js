const { net } = require('electron');
const https = require('https');

const TIMEOUT_MS = 4000;
const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

function mergeHeaders(extra) {
  return { ...DEFAULT_HEADERS, ...(extra || {}) };
}

function decodeBuffer(buf, encoding) {
  if (!encoding || encoding === 'utf8' || encoding === 'utf-8') {
    return Buffer.from(buf).toString('utf8');
  }
  try {
    return new TextDecoder(encoding).decode(buf);
  } catch (_) {
    return Buffer.from(buf).toString('utf8');
  }
}

function requestWithNet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET' });
    Object.entries(headers).forEach(([k, v]) => req.setHeader(k, v));
    const chunks = [];
    const timer = setTimeout(() => {
      try {
        req.abort();
      } catch (_) {
        /* ignore */
      }
      reject(new Error('quote timeout'));
    }, TIMEOUT_MS);
    req.on('response', (res) => {
      res.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

function requestWithHttps(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: TIMEOUT_MS, family: 4 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('quote timeout')));
    req.on('error', reject);
  });
}

function requestBuffer(url, extraHeaders) {
  const headers = mergeHeaders(extraHeaders);
  return requestWithNet(url, headers).catch(() => requestWithHttps(url, headers));
}

function requestText(url, extraHeaders, encoding) {
  return requestBuffer(url, extraHeaders).then((buf) => decodeBuffer(buf, encoding));
}

function requestJson(url, extraHeaders, encoding) {
  return requestText(url, extraHeaders, encoding).then((raw) => JSON.parse(raw));
}

function firstSettled(promises) {
  return Promise.any(promises).catch((err) => {
    const first = err && err.errors && err.errors[0] ? err.errors[0] : err;
    throw first;
  });
}

module.exports = {
  TIMEOUT_MS,
  requestBuffer,
  requestText,
  requestJson,
  firstSettled
};
