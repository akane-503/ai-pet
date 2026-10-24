'use strict';
const quotaOnly = require('../../package.json').aiPetEdition === 'quota';
module.exports = { quotaOnly, name: quotaOnly ? 'AI 桌宠 B' : 'AI 桌宠', id: quotaOnly ? 'com.akane503.aipet.quota' : 'com.akane503.aipet' };
