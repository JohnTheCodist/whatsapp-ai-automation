/**
 * Public surface of the block contract.
 *
 * Everything outside `blocks/` imports from here, not from the files beneath
 * it. That keeps the internal split — types, registry, render, definitions —
 * free to change without touching websiteService, templates, the routes, or
 * the future editor adapter.
 */

const registry = require('./registry');
const { editorManifest } = require('./editorManifest');
const render = require('./render');

module.exports = {
  // registry
  getBlock: registry.getBlock,
  latestVersion: registry.latestVersion,
  listBlocks: registry.listBlocks,
  blockIds: registry.blockIds,
  blockKey: registry.blockKey,
  DEFINITIONS: registry.DEFINITIONS,

  // validation
  validateBlock: registry.validateBlock,

  // rendering
  renderBlock: registry.renderBlock,
  renderSite: registry.renderSite,
  esc: render.esc,
  whatsappUrl: render.whatsappUrl,
  resolveProps: render.resolveProps,

  // editor adapter boundary
  editorManifest,
};
