const eastmoney = require('./eastmoney');
const tencent = require('./tencent');
const sina = require('./sina');

const QUOTE_PROVIDERS = [
  { id: 'eastmoney', label: '东方财富', short: '东财' },
  { id: 'tencent', label: '腾讯财经', short: '腾讯' },
  { id: 'sina', label: '新浪财经', short: '新浪' }
];

const IMPLEMENTATIONS = {
  eastmoney,
  tencent,
  sina
};

function normalizeProviderId(id) {
  return IMPLEMENTATIONS[id] ? id : 'eastmoney';
}

function getQuoteProvider(id) {
  return IMPLEMENTATIONS[normalizeProviderId(id)];
}

function providerMeta(id) {
  const key = normalizeProviderId(id);
  return QUOTE_PROVIDERS.find((p) => p.id === key) || QUOTE_PROVIDERS[0];
}

module.exports = {
  QUOTE_PROVIDERS,
  normalizeProviderId,
  getQuoteProvider,
  providerMeta
};
