'use strict';

/**
 * Copies the single-file web application into the desktop bundle so the packaged
 * build always ships the current version of the interface.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', '..', 'Prp100 .html');
const TARGET_DIR = path.join(__dirname, '..', 'app');
const TARGET = path.join(TARGET_DIR, 'index.html');

if(!fs.existsSync(SOURCE)){
    console.error('Application file not found:', SOURCE);
    process.exit(1);
}

fs.mkdirSync(TARGET_DIR, { recursive: true });
fs.copyFileSync(SOURCE, TARGET);

const size = fs.statSync(TARGET).size;
console.log('Copied interface to', TARGET, '(' + Math.round(size / 1024) + ' KB)');
