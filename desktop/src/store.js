'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SCHEMA_VERSION = 1;
const FLUSH_DELAY_MS = 150;
const BACKUP_INTERVAL_MS = 60 * 60 * 1000;

function stamp(date){
    const pad = (n) => String(n).padStart(2, '0');
    return date.getFullYear()
        + pad(date.getMonth() + 1)
        + pad(date.getDate())
        + '-' + pad(date.getHours())
        + pad(date.getMinutes())
        + pad(date.getSeconds());
}

/**
 * Key/value database kept in a single JSON file outside the application bundle.
 * Writes are coalesced, written to a temporary file, fsynced and then renamed,
 * so an interrupted write can never truncate the live database.
 */
class JsonDatabase {
    constructor(options){
        const opts = options || {};
        if(!opts.file) throw new Error('JsonDatabase requires a file path');
        this.file = opts.file;
        this.backupDir = opts.backupDir || path.join(path.dirname(opts.file), 'backups');
        this.maxBackups = Number(opts.maxBackups) > 0 ? Number(opts.maxBackups) : 30;
        this.data = Object.create(null);
        this.loadedFrom = null;
        this.restoredFromBackup = false;
        this.lastWriteAt = null;
        this.lastBackupAt = 0;
        this._dirty = false;
        this._chain = Promise.resolve();
        this._flushTimer = null;
        this._flushPromise = null;
    }

    async load(){
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        await fsp.mkdir(this.backupDir, { recursive: true });

        const primary = await this._read(this.file);
        if(primary.status === 'ok'){
            this.data = primary.data;
            this.loadedFrom = this.file;
            return this.info();
        }

        if(primary.status === 'corrupt'){
            const quarantine = this.file + '.corrupt-' + stamp(new Date());
            await fsp.rename(this.file, quarantine).catch(() => {});
            const recovered = await this._loadNewestBackup();
            if(recovered){
                this.data = recovered.data;
                this.loadedFrom = recovered.file;
                this.restoredFromBackup = true;
                this._dirty = true;
                await this.flush();
            }
        }

        if(!this.loadedFrom) this.loadedFrom = null;
        return this.info();
    }

    keys(){
        return Object.keys(this.data);
    }

    get(key){
        const value = this.data[String(key)];
        return value === undefined ? undefined : value;
    }

    /**
     * Stores a value and resolves once it has reached the disk, so callers that
     * await the result can trust that the data survived an immediate shutdown.
     */
    set(key, value){
        const name = String(key);
        if(value === undefined) delete this.data[name];
        else this.data[name] = value;
        this._dirty = true;

        if(!this._flushTimer){
            this._flushPromise = new Promise((resolve) => {
                this._flushTimer = setTimeout(() => {
                    this._flushTimer = null;
                    resolve(this.flush());
                }, FLUSH_DELAY_MS);
            });
            this._flushPromise.catch(() => {});
        }
        return this._flushPromise;
    }

    flush(){
        if(!this._dirty) return this._chain;
        this._dirty = false;
        return this._enqueue(() => this._write());
    }

    async backupNow(){
        await this.flush();
        const payload = this._serialize();
        const file = await this._writeBackup(payload);
        return { file: file, keyCount: this.keys().length };
    }

    info(){
        return {
            file: this.file,
            backupDir: this.backupDir,
            loadedFrom: this.loadedFrom,
            restoredFromBackup: this.restoredFromBackup,
            keyCount: this.keys().length,
            lastWriteAt: this.lastWriteAt,
            schema: SCHEMA_VERSION
        };
    }

    _enqueue(task){
        this._chain = this._chain.then(task, task);
        return this._chain;
    }

    _serialize(){
        return JSON.stringify({
            schema: SCHEMA_VERSION,
            updatedAt: new Date().toISOString(),
            data: this.data
        });
    }

    async _write(){
        const payload = this._serialize();
        const temp = this.file + '.tmp';
        try{
            await fsp.mkdir(path.dirname(this.file), { recursive: true });
            const handle = await fsp.open(temp, 'w');
            try{
                await handle.writeFile(payload, 'utf8');
                await handle.sync();
            } finally {
                await handle.close();
            }
            await fsp.rename(temp, this.file);
            this.lastWriteAt = new Date().toISOString();
            if(!this.loadedFrom) this.loadedFrom = this.file;
        }catch(error){
            this._dirty = true;
            await fsp.unlink(temp).catch(() => {});
            throw error;
        }

        if(Date.now() - this.lastBackupAt >= BACKUP_INTERVAL_MS){
            await this._writeBackup(payload).catch(() => {});
        }
        return this.info();
    }

    async _writeBackup(payload){
        await fsp.mkdir(this.backupDir, { recursive: true });
        const file = path.join(this.backupDir, 'prp-database-' + stamp(new Date()) + '.json');
        await fsp.writeFile(file, payload, 'utf8');
        this.lastBackupAt = Date.now();
        await this._pruneBackups();
        return file;
    }

    async _pruneBackups(){
        const entries = await fsp.readdir(this.backupDir).catch(() => []);
        const backups = entries
            .filter((name) => /^prp-database-.*\.json$/.test(name))
            .sort();
        const excess = backups.length - this.maxBackups;
        for(let i = 0; i < excess; i++){
            await fsp.unlink(path.join(this.backupDir, backups[i])).catch(() => {});
        }
    }

    async _read(file){
        let text;
        try{
            text = await fsp.readFile(file, 'utf8');
        }catch(error){
            if(error && error.code === 'ENOENT') return { status: 'missing' };
            return { status: 'corrupt', error: error };
        }
        try{
            const parsed = JSON.parse(text);
            const data = (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object')
                ? parsed.data
                : parsed;
            if(!data || typeof data !== 'object' || Array.isArray(data)) return { status: 'corrupt' };
            return { status: 'ok', data: Object.assign(Object.create(null), data) };
        }catch(error){
            return { status: 'corrupt', error: error };
        }
    }

    async _loadNewestBackup(){
        const entries = await fsp.readdir(this.backupDir).catch(() => []);
        const backups = entries
            .filter((name) => /^prp-database-.*\.json$/.test(name))
            .sort()
            .reverse();
        for(const name of backups){
            const file = path.join(this.backupDir, name);
            const result = await this._read(file);
            if(result.status === 'ok') return { file: file, data: result.data };
        }
        return null;
    }
}

module.exports = { JsonDatabase, SCHEMA_VERSION };
