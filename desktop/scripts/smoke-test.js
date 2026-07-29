'use strict';

/**
 * Launches the desktop application against a throw-away data directory and
 * verifies that patient records survive a reload through the external database
 * file. On Linux without a display, run through `xvfb-run -a npm test`.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const electron = require('electron');

const PORT = 9229;
const PATIENT_ID = 'p_smoke_test';
const PATIENT_NAME = 'بیمار آزمایشی';
const PATIENTS_KEY = 'prp_data_v38_final_fixed';

function wait(ms){
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findPage(attempts){
    for(let i = 0; i < attempts; i++){
        try{
            const response = await fetch('http://127.0.0.1:' + PORT + '/json');
            const targets = await response.json();
            const page = targets.find((target) => target.type === 'page');
            if(page) return page.webSocketDebuggerUrl;
        }catch(error){ /* the app is still starting */ }
        await wait(500);
    }
    throw new Error('The application window did not become available');
}

async function connect(url){
    const socket = new WebSocket(url);
    const pending = new Map();
    const exceptions = [];
    let counter = 0;

    socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if(message.id && pending.has(message.id)){
            const entry = pending.get(message.id);
            pending.delete(message.id);
            if(message.error) entry.reject(new Error(message.error.message));
            else entry.resolve(message.result);
            return;
        }
        if(message.method === 'Runtime.exceptionThrown'){
            exceptions.push(message.params.exceptionDetails.text);
        }
    };

    await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = reject;
    });

    const send = (method, params) => new Promise((resolve, reject) => {
        const id = ++counter;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });

    await send('Runtime.enable');
    await send('Page.enable');

    return {
        exceptions: exceptions,
        send: send,
        close: () => socket.close(),
        async evaluate(expression){
            const result = await send('Runtime.evaluate', {
                expression: '(async () => { ' + expression + ' })()',
                awaitPromise: true,
                returnByValue: true
            });
            if(result.exceptionDetails) throw new Error(result.exceptionDetails.text);
            return result.result.value;
        }
    };
}

async function main(){
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prp-smoke-'));
    const databaseFile = path.join(dataDir, 'prp-database.json');
    const results = [];

    const child = spawn(electron, ['--no-sandbox', '--remote-debugging-port=' + PORT, '.'], {
        cwd: path.join(__dirname, '..'),
        env: Object.assign({}, process.env, { PRP_DATA_DIR: dataDir }),
        stdio: 'ignore'
    });

    try{
        const client = await connect(await findPage(40));

        const bridge = await client.evaluate('return { native: !!(window.prpNativeStore && window.prpNativeStore.isNative), info: await window.prpNativeStore.info() };');
        results.push(['native database bridge is available', bridge.native === true]);
        results.push(['database path points at the external file', bridge.info.file === databaseFile]);

        await client.evaluate(`
            window.patients = Array.isArray(window.patients) ? window.patients : [];
            window.patients.push({
                id: '${PATIENT_ID}', fullName: ${JSON.stringify(PATIENT_NAME)}, phone: '09120000000',
                nationalId: '', site: 'آزمایش', currentStage: 1, status: 'PENDING_CALL',
                regDate: new Date().toISOString(), createdAt: new Date().toISOString(), history: []
            });
            await saveData();
            return true;
        `);

        const onDisk = JSON.parse(fs.readFileSync(databaseFile, 'utf8'));
        const stored = (onDisk.data[PATIENTS_KEY] || []).find((patient) => patient.id === PATIENT_ID);
        results.push(['record written to the external database file', !!stored]);
        results.push(['record content preserved', !!stored && stored.fullName === PATIENT_NAME]);

        await client.send('Page.reload', { ignoreCache: true });
        client.close();
        await wait(2500);

        const reloaded = await connect(await findPage(20));
        const restored = await reloaded.evaluate(`
            for(var i = 0; i < 40; i++){
                if(Array.isArray(window.patients) && window.patients.some(function(p){ return p.id === '${PATIENT_ID}'; })) break;
                await new Promise(function(resolve){ setTimeout(resolve, 250); });
            }
            var found = (window.patients || []).find(function(p){ return p.id === '${PATIENT_ID}'; });
            return found ? found.fullName : null;
        `);
        results.push(['record reloaded from the external database', restored === PATIENT_NAME]);
        results.push(['no runtime exceptions were raised', reloaded.exceptions.length === 0]);
        reloaded.close();
    } finally {
        child.kill();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }

    let failures = 0;
    for(const [label, passed] of results){
        if(!passed) failures++;
        console.log((passed ? 'PASS' : 'FAIL') + ' - ' + label);
    }
    if(failures){
        console.error('\n' + failures + ' check(s) failed');
        process.exitCode = 1;
    } else {
        console.log('\nAll desktop database checks passed');
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
