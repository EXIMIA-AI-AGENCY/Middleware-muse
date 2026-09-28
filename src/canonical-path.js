'use strict';

/**
 * The path as the upstream's edge will see it: percent-decoded, dot segments resolved, backslashes
 * as slashes, repeated slashes collapsed, lower case, no trailing slash. Guards compare
 * against this so an encoded or dotted path cannot slip past them.
 */
function canonicalPath(url) {
  // Cut at a fragment too: URL parsers upstream would drop everything after '#'.
  let path = String(url).split(/[?#]/, 1)[0];
  for (let i = 0; ; i += 1) {
    let decoded;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null; // malformed encoding: the caller refuses it
    }
    if (decoded === path) break;
    if (i === 4) return null; // encoded over and over: refused rather than guessed
    path = decoded;
  }
  // By hand, not with the URL parser: "//host/..." would be read as a host, not a path.
  const segments = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`.toLowerCase();
}

module.exports = { canonicalPath };
