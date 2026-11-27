"use strict";
const { isIP } = require('node:net');
function publicUrl(value, originOnly = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Release URLs must be absolute HTTPS URLs.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /(?:^|\.)(?:localhost|local|example|invalid|test)$/.test(host) || /(?:^|\.)example\.(?:com|org|net)$/.test(host) || (originOnly && url.pathname !== '/')) throw new Error('Release URLs require a public HTTPS hostname without credentials, query, fragment or port.');
  return originOnly ? url.origin : url.href.replace(/\/+$/, '') + '/';
}
function target(platform, arch) { if (!['mac','win'].includes(platform) || !['x64','arm64'].includes(arch)) throw new Error('Choose mac/win and x64/arm64.'); return { platform, arch }; }
function required(env, names) { const missing = names.filter(name => !String(env[name] ?? '').trim()); if (missing.length) throw new Error('Missing desktop release settings: ' + missing.join(', ')); }
function releaseConfiguration(env, { credentials = true } = {}) {
  required(env, ['SFU_DESKTOP_SERVER_URL','SFU_DESKTOP_WEBSITE_URL','SFU_DESKTOP_ADMIN_URL','SFU_DESKTOP_DISTRIBUTION_URL','SFU_DESKTOP_TARGET_PLATFORM','SFU_DESKTOP_TARGET_ARCH']);
  const { platform, arch } = target(env.SFU_DESKTOP_TARGET_PLATFORM, env.SFU_DESKTOP_TARGET_ARCH);
  const distributionUrl = publicUrl(env.SFU_DESKTOP_DISTRIBUTION_URL);
  const updateUrl = distributionUrl + 'stable/' + platform + '/' + arch + '/';
  if (env.SFU_DESKTOP_UPDATE_URL && publicUrl(env.SFU_DESKTOP_UPDATE_URL) !== updateUrl) throw new Error('The update feed must match the release platform and architecture.');
  const result = { platform, arch, serverUrl: publicUrl(env.SFU_DESKTOP_SERVER_URL, true), websiteUrl: publicUrl(env.SFU_DESKTOP_WEBSITE_URL, true), adminPortalUrl: publicUrl(env.SFU_DESKTOP_ADMIN_URL, true), distributionUrl, updateUrl };
  if (platform === 'mac') {
    required(env, ['APPLE_TEAM_ID']); if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('APPLE_TEAM_ID must contain ten uppercase letters/digits.');
    result.teamId = env.APPLE_TEAM_ID;
    if (credentials) required(env, ['CSC_LINK','CSC_KEY_PASSWORD','APPLE_API_KEY','APPLE_API_KEY_ID','APPLE_API_ISSUER']);
  } else {
    required(env, ['SFU_DESKTOP_WIN_PUBLISHER','SFU_DESKTOP_AZURE_ENDPOINT','SFU_DESKTOP_AZURE_ACCOUNT','SFU_DESKTOP_AZURE_PROFILE']);
    const endpoint = new URL(env.SFU_DESKTOP_AZURE_ENDPOINT);
    if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.codesigning\.azure\.net$/.test(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.port || endpoint.pathname !== '/') throw new Error('Use the Azure Artifact Signing regional HTTPS endpoint.');
    result.publisher = env.SFU_DESKTOP_WIN_PUBLISHER.trim();
    result.azureSignOptions = { publisherName: result.publisher, endpoint: endpoint.origin, codeSigningAccountName: env.SFU_DESKTOP_AZURE_ACCOUNT, certificateProfileName: env.SFU_DESKTOP_AZURE_PROFILE };
    if (credentials) required(env, ['AZURE_TENANT_ID','AZURE_CLIENT_ID','AZURE_CLIENT_SECRET']);
  }
  return result;
}
module.exports = { publicUrl, target, releaseConfiguration };
if (require.main === module) { try { const config = releaseConfiguration(process.env); process.stdout.write(JSON.stringify({ platform: config.platform, arch: config.arch, updateUrl: config.updateUrl, ready: true }) + '\n'); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; } }
