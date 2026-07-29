'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FOLDER_NAME = 'PRP-Data';
const DATABASE_FILE_NAME = 'prp-database.json';

function isWritable(dir){
    try{
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, '.write-test-' + process.pid);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return true;
    }catch(error){
        return false;
    }
}

/**
 * Chooses where the database lives. A portable build keeps its data next to the
 * executable so the whole folder can be copied or backed up as one unit; if that
 * location is read-only (for example an installation under Program Files) the
 * per-user application folder is used instead.
 */
function resolveDataDirectory(app){
    const candidates = [];
    if(process.env.PRP_DATA_DIR) candidates.push(process.env.PRP_DATA_DIR);
    if(process.env.PORTABLE_EXECUTABLE_DIR) candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, DATA_FOLDER_NAME));
    if(app.isPackaged) candidates.push(path.join(path.dirname(app.getPath('exe')), DATA_FOLDER_NAME));
    else candidates.push(path.join(app.getAppPath(), '.dev-data'));
    candidates.push(path.join(app.getPath('appData'), 'PRP-Clinic-Manager', DATA_FOLDER_NAME));

    for(const candidate of candidates){
        const resolved = path.resolve(candidate);
        if(isWritable(resolved)) return resolved;
    }
    throw new Error('No writable data directory found. Set PRP_DATA_DIR to a writable folder.');
}

function resolveDatabaseFile(dataDir){
    return path.join(dataDir, DATABASE_FILE_NAME);
}

function resolveAppHtml(app){
    const candidates = [
        path.join(app.getAppPath(), 'app', 'index.html'),
        path.join(process.resourcesPath || '', 'app', 'index.html'),
        path.join(app.getAppPath(), '..', 'Prp100 .html')
    ];
    for(const candidate of candidates){
        if(candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
}

module.exports = {
    DATA_FOLDER_NAME,
    DATABASE_FILE_NAME,
    resolveDataDirectory,
    resolveDatabaseFile,
    resolveAppHtml
};
