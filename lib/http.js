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

function acceptBody(status, buf) {
  if (status && (status < 200 || status >= 300)) {
    throw new Error(`http ${status}`);
  }
  if (!buf || !buf.length) {
    throw new Error('empty body');
  }
  return buf;
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
      const status = res.statusCode;
      res.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          resolve(acceptBody(status, Buffer.concat(chunks)));
        } catch (err) {
          reject(err);
        }
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
      const status = res.statusCode;
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(acceptBody(status, Buffer.concat(chunks)));
        } catch (err) {
          reject(err);
        }
      });
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

function firstSettledStaggered(starters, gapMs = 350) {
  const list = (Array.isArray(starters) ? starters : []).filter((fn) => typeof fn === 'function');
  if (!list.length) return Promise.reject(new Error('no request'));
  if (list.length === 1) return Promise.resolve().then(list[0]);
  let settled = false;
  const timers = [];
  const tasks = list.map(
    (start, i) =>
      new Promise((resolve, reject) => {
        const run = () => {
          if (settled) {
            reject(new Error('stale'));
            return;
          }
          Promise.resolve()
            .then(start)
            .then(resolve, reject);
        };
        if (i === 0) run();
        else timers.push(setTimeout(run, gapMs * i));
      })
  );
  return Promise.any(tasks).then(
    (value) => {
      settled = true;
      timers.forEach(clearTimeout);
      return value;
    },
    (err) => {
      settled = true;
      timers.forEach(clearTimeout);
      const errors = err && Array.isArray(err.errors) ? err.errors : [err];
      const first = errors.find((e) => e && e.message !== 'stale') || errors[0] || err;
      throw first;
    }
  );
}

function trySequence(starters) {
  const list = (Array.isArray(starters) ? starters : []).filter((fn) => typeof fn === 'function');
  if (!list.length) return Promise.reject(new Error('no request'));
  return list.reduce(
    (p, start) => p.catch(() => Promise.resolve().then(start)),
    Promise.reject(new Error('no request'))
  );
}

module.exports = {
  TIMEOUT_MS,
  requestBuffer,
  requestText,
  requestJson,
  firstSettled,
  firstSettledStaggered,
  trySequence
};
