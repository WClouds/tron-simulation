/**
 * util/uid.js
 *
 * @author  Denis Luchkin-Zhou <denis@ricepo.com>
 * @license 2015-16 (C) Ricepo LLC. All Rights Reserved.
 *
 * @desc    ID generation and conversion.
 */
const ShortId      = require('shortid');
const ObjectId     = require('bson-objectid');



/**
 * Export stuff
 */
module.exports = {
  generate,
  canon
};



/**
 * Regex pattern for valid IDs
 */
const pattern = /^([a-zA-Z0-9]+)_([a-zA-Z0-9$@_-]+)$/;



/**
 * ID generation
 */
function generate(prefix) {

  /* Generate short ID */
  const uid = ShortId.generate();

  /* Refuse to generate unprefixed IDs */
  if (typeof prefix !== 'string') {
    throw new Error('ID generation requires a string prefix');
  }

  return `${prefix}_${uid}`;
}



/**
 * ID canonicalization
 */
function canon(v) {

  /* When v is falsy, return null */
  if (!v) { return null; }

  /* If this is a BSON ObjectId, deserialize it */
  if (ObjectId.isValid(v)) { return ObjectId(v); }


  /* Check if this is a valid string ID */
  const match = pattern.exec(v);


  /* if not valid, throw error */
  if (!match || !ShortId.isValid(match[2])) {
    throw new Error('Attempting to convert an invalid ID');
  }

  return v;
}
