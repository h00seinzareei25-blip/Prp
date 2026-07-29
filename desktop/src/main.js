'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');

const { JsonDatabase } = require('./store');
const { resolveDataDirectory, resolveDatabaseFile, resolveAppHtml } = require('./paths');

if(!app.requestSingleInstanceLock()){
    app.quit();
    return;
}

const dataDir = resolveDataDirectory(app);
const databaseFile = resolveDatabaseFile(dataDir);

// Browser-level storage (localStorage used by a few legacy settings) is kept in the
// same folder as the database so the whole data directory stays self-contained.
app.setPath('userData', path.join(dataDir, 'app-state'));

const database = new JsonDatabase({ file: databaseFile });

let mainWindow = null;
let quitting = false;

function createWindow(){
    const htmlFile = resolveAppHtml(app);
    if(!htmlFile){
        dialog.showErrorBox('فایل برنامه پیدا نشد', 'فایل رابط کاربری برنامه یافت نشد. دستور «npm run sync» را اجرا کنید.');
        app.quit();
        return;
    }

    mainWindow = new BrowserWindow({
        width: 1500,
        height: 950,
        minWidth: 1024,
        minHeight: 700,
        backgroundColor: '#f8fafc',
        show: false,
        title: 'سامانه مدیریت هوشمند PRP',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false
        }
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if(/^https?:/i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.loadFile(htmlFile);
}

function buildMenu(){
    const template = [
        {
            label: 'برنامه',
            submenu: [
                { label: 'بازخوانی', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
                { label: 'تمام‌صفحه', accelerator: 'F11', role: 'togglefullscreen' },
                { type: 'separator' },
                { label: 'بزرگ‌نمایی بیشتر', role: 'zoomIn' },
                { label: 'بزرگ‌نمایی کمتر', role: 'zoomOut' },
                { label: 'بزرگ‌نمایی پیش‌فرض', role: 'resetZoom' },
                { type: 'separator' },
                { label: 'ابزار توسعه‌دهنده', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow && mainWindow.webContents.toggleDevTools() },
                { type: 'separator' },
                { label: 'خروج', role: 'quit' }
            ]
        },
        {
            label: 'ویرایش',
            submenu: [
                { label: 'واگرد', role: 'undo' },
                { label: 'ازنو', role: 'redo' },
                { type: 'separator' },
                { label: 'برش', role: 'cut' },
                { label: 'کپی', role: 'copy' },
                { label: 'چسباندن', role: 'paste' },
                { label: 'انتخاب همه', role: 'selectAll' }
            ]
        },
        {
            label: 'دیتابیس',
            submenu: [
                {
                    label: 'باز کردن پوشه داده‌ها',
                    click: () => shell.openPath(dataDir)
                },
                {
                    label: 'پشتیبان‌گیری فوری',
                    click: async () => {
                        try{
                            const result = await database.backupNow();
                            dialog.showMessageBox(mainWindow, {
                                type: 'info',
                                title: 'پشتیبان‌گیری انجام شد',
                                message: 'یک نسخه پشتیبان ساخته شد.',
                                detail: result.file
                            });
                        }catch(error){
                            dialog.showErrorBox('پشتیبان‌گیری ناموفق', String(error && error.message ? error.message : error));
                        }
                    }
                },
                {
                    label: 'اطلاعات دیتابیس',
                    click: () => {
                        const info = database.info();
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: 'اطلاعات دیتابیس',
                            message: 'فایل دیتابیس این نسخه:',
                            detail: [
                                'فایل: ' + info.file,
                                'پوشه پشتیبان: ' + info.backupDir,
                                'تعداد کلیدها: ' + info.keyCount,
                                'آخرین ذخیره: ' + (info.lastWriteAt || 'هنوز ذخیره‌ای انجام نشده'),
                                info.restoredFromBackup ? 'این داده‌ها از نسخه پشتیبان بازیابی شده‌اند.' : ''
                            ].filter(Boolean).join('\n')
                        });
                    }
                }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('prp-store:get', (event, key) => database.get(key));
ipcMain.handle('prp-store:set', async (event, key, value) => {
    await database.set(key, value);
    return true;
});
ipcMain.handle('prp-store:keys', () => database.keys());
ipcMain.handle('prp-store:info', () => database.info());
ipcMain.handle('prp-store:backup', () => database.backupNow());

app.on('second-instance', () => {
    if(mainWindow){
        if(mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (event) => {
    if(quitting) return;
    event.preventDefault();
    quitting = true;
    database.flush()
        .catch((error) => console.error('Failed to flush database before quit', error))
        .then(() => app.quit());
});

app.whenReady().then(async () => {
    try{
        const info = await database.load();
        console.log('PRP database:', info.file, '| keys:', info.keyCount);
        if(info.restoredFromBackup){
            dialog.showMessageBox({
                type: 'warning',
                title: 'بازیابی از پشتیبان',
                message: 'فایل دیتابیس سالم نبود و از آخرین نسخه پشتیبان بازیابی شد.',
                detail: 'نسخه آسیب‌دیده با پسوند corrupt در همان پوشه نگه داشته شد.'
            });
        }
    }catch(error){
        dialog.showErrorBox('خطا در بازکردن دیتابیس', String(error && error.message ? error.message : error));
        app.quit();
        return;
    }
    buildMenu();
    createWindow();
});
