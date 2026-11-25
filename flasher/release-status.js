// Release metadata is advisory. Only the signed catalog authorizes firmware.
import { validateBlackjack } from './blackjack.js';
import { requireThat, permittedRange, roundUp, seederVoxelFlightRange } from './core.js';

const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(value);
export function safeLink(value, anchor = false) {
  if (anchor && typeof value === 'string' && /^#[a-zA-Z0-9_-]+$/.test(value)) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
const unique = (rows, field, message) => {
  requireThat(Array.isArray(rows) && rows.every(r => r && id(r[field])) && new Set(rows.map(r => r[field])).size === rows.length, message);
};

export function validateCatalog(catalog) {
  requireThat(catalog && catalog.format === 1, 'Unsupported catalog.');
  unique(catalog.projects, 'id', 'Invalid or duplicate project IDs.');
  unique(catalog.devices, 'id', 'Invalid or duplicate device IDs.');
  requireThat(catalog.projects.length > 0 && catalog.devices.length > 0, 'Empty device/project catalog.');
  for (const p of catalog.projects) requireThat(text(p.name) && text(p.category) && (!p.url || safeLink(p.url)), 'Invalid project metadata.');
  for (const d of catalog.devices) {
    requireThat(text(d.name) && text(d.model) && text(d.recovery) && /^images\/[a-zA-Z0-9._/-]+$/.test(d.image) && !d.image.includes('..'), 'Invalid device metadata.');
    requireThat((d.id === 'sticks3' && d.flashBytes === 8388608) || (d.id === 'waveshare175c' && d.flashBytes === 33554432), 'Unsupported device flash contract.');
    const box = typeof d.viewBox === 'string' ? d.viewBox.trim().split(/\s+/).map(Number) : [];
    requireThat(box.length === 4 && box.every(Number.isFinite) && box[0] >= 0 && box[1] >= 0 && box[2] > 0 && box[3] > 0, 'Invalid device image bounds.');
  }
  requireThat(Array.isArray(catalog.releases) && catalog.releases.length > 0 && (!catalog.recoveryReleases || Array.isArray(catalog.recoveryReleases)), 'Missing releases.');
  const all = [...catalog.releases, ...(catalog.recoveryReleases || [])];
  unique(all, 'id', 'Invalid or duplicate release IDs.');
  const slots = new Set();
  for (const r of all) {
    const d = catalog.devices.find(d => d.id === r.device);
    requireThat(d && catalog.projects.some(p => p.id === r.project), 'Release references an unknown project or device.');
    const current = catalog.releases.includes(r);
    requireThat(version(r.version) || (!current && typeof r.version === 'string' && version(r.version.replace(/ candidate$/, ''))), 'Invalid release version.');
    requireThat(text(r.status) && text(r.description) && text(r.qualification) && safeLink(r.source, true) && safeLink(r.manual, true), 'Invalid release provenance or captions.');
    if (current) { const slot = `${r.project}/${r.device}`; requireThat(!slots.has(slot), 'Multiple current releases for one project/device.'); slots.add(slot); }
    validateBlackjack(r,d);
    unique(r.files, 'id', 'Invalid or duplicate firmware file IDs.');
    requireThat(r.files.length > 0 && r.files.every(f => /^[a-zA-Z0-9._-]+\.bin$/.test(f.id) && f.url === `firmware/${f.id}` && integer(f.bytes) && f.bytes > 0 && f.bytes <= d.flashBytes && /^[a-f0-9]{64}$/.test(f.sha256)), 'Invalid firmware file contract.');
    requireThat(Array.isArray(r.parts) && r.parts.length > 0 && r.parts.length <= 16, 'Missing firmware parts.');
    for (const part of r.parts) {
      const file = r.files.find(f => f.id === part.file);
      requireThat(file && integer(part.sourceOffset) && integer(part.length) && part.length > 0 && part.sourceOffset + part.length <= file.bytes && permittedRange(d, part.address, roundUp(part.length)) && ['application','bootloader','partitions','ota','assets'].includes(part.kind), 'Invalid firmware part contract.');
    }
    const parts = [...r.parts].sort((a,b) => a.address - b.address);
    requireThat(parts.every((p,i) => !i || p.address >= parts[i-1].address + roundUp(parts[i-1].length)), 'Overlapping firmware parts.');
    if (d.id === 'waveshare175c') requireThat(parts.length === 1 && parts[0].kind === 'application' && parts[0].address === 0x200000, 'Waveshare requires application-only firmware.');
    seederVoxelFlightRange(r,d);
    unique(r.partitions, 'label', 'Invalid or duplicate partition labels.');
    requireThat(r.partitions.length > 0 && r.partitions.every(p => integer(p.type) && p.type <= 255 && integer(p.subtype) && p.subtype <= 255 && integer(p.flags) && p.flags <= 0xffffffff && integer(p.offset) && p.offset >= 0x9000 && integer(p.size) && p.size > 0 && p.offset % 4096 === 0 && p.size % 4096 === 0 && p.offset + p.size <= d.flashBytes), 'Invalid partition contract.');
  }
  requireThat(Array.isArray(catalog.otherProjects) && catalog.otherProjects.every(p => text(p.name) && text(p.detail) && safeLink(p.url)), 'Invalid project links.');
  return catalog;
}

export function validateReleaseStatus(status) {
  requireThat(status && Number.isFinite(Date.parse(status.checkedAt)) && Array.isArray(status.projects), 'Invalid release-check metadata.');
  unique(status.projects, 'project', 'Duplicate release-check projects.');
  for (const p of status.projects) {
    requireThat(typeof p.repository === 'string' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(p.repository) && ['current','blocked','unavailable'].includes(p.state) && text(p.message), 'Invalid release-check project.');
    requireThat(!p.releaseUrl || (safeLink(p.releaseUrl) && p.releaseUrl.startsWith(`https://github.com/${p.repository}/releases/`)), 'Invalid GitHub release link.');
    requireThat(!p.tag || text(p.tag), 'Invalid release tag.');
    unique(p.devices, 'device', 'Duplicate release-check devices.');
    requireThat(p.devices.every(d => version(d.offeredVersion)), 'Invalid offered version.');
  }
  return status;
}

export async function fetchReleaseStatus(fetcher = fetch) {
  try {
    const response = await fetcher('release-status.json', { cache:'no-store', signal:AbortSignal.timeout(10000) });
    requireThat(response.ok, 'Release check unavailable.');
    return validateReleaseStatus(await response.json());
  } catch { return null; }
}

export function describeReleaseStatus(status, release, now = Date.now()) {
  const unknown = message => ({ state:'unavailable', message, releaseUrl:null });
  if (!status) return unknown('GitHub release check unavailable. Latest release not confirmed.');
  const checked = Date.parse(status.checkedAt), age = now - checked;
  if (!Number.isFinite(checked) || age < -300000 || age > 45*60000) return unknown(`GitHub release check is out of date${Number.isFinite(checked) ? ` (last checked ${new Date(checked).toLocaleString()})` : ''}. Latest release not confirmed.`);
  const project = status.projects.find(p => p.project === release.project);
  const offered = project?.devices.find(d => d.device === release.device);
  if (!project || offered?.offeredVersion !== release.version) return unknown('Release-check metadata does not match this build. Latest release not confirmed.');
  const when = new Date(checked).toLocaleString();
  return { state:project.state, releaseUrl:project.releaseUrl || null, message:`${project.state === 'current' ? 'Release sync checked' : project.state === 'blocked' ? 'Release sync blocked' : 'Release check unavailable'} · ${when}${project.tag ? ` · ${project.tag}` : ''}. ${project.message}` };
}

export function pinRelease(release) {
  const copy = structuredClone(release);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  return freeze(copy);
}
