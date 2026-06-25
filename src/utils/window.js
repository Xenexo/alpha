const { BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('node:path');
const storage = require('../storage');

let mouseEventsIgnored = false;
let clipboardWatchInterval = null;
let lastClipboardText = '';
let autoSelectionEnabled = false;

const DEFAULT_MAIN_WINDOW_SIZE = { width: 1100, height: 800 };
const MIN_WINDOW_SIZE = { width: 700, height: 320 };

function createWindow(sendToRenderer, geminiSessionRef) {
    let windowWidth = DEFAULT_MAIN_WINDOW_SIZE.width;
    let windowHeight = DEFAULT_MAIN_WINDOW_SIZE.height;

    const mainWindow = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        minWidth: MIN_WINDOW_SIZE.width,
        minHeight: MIN_WINDOW_SIZE.height,
        resizable: true,
        frame: false,
        transparent: true,
        hasShadow: false,
        alwaysOnTop: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false, // TODO: change to true
            backgroundThrottling: false,
            enableBlinkFeatures: 'GetDisplayMedia',
            webSecurity: true,
            allowRunningInsecureContent: false,
        },
        backgroundColor: '#00000000',
    });

    const { session, desktopCapturer } = require('electron');
    session.defaultSession.setDisplayMediaRequestHandler(
        (request, callback) => {
            desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
                callback({ video: sources[0], audio: 'loopback' });
            });
        },
        { useSystemPicker: true }
    );

    mainWindow.setContentProtection(true);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Hide from Windows taskbar
    if (process.platform === 'win32') {
        try {
            mainWindow.setSkipTaskbar(true);
        } catch (error) {
            console.warn('Could not hide from taskbar:', error.message);
        }
    }

    // Hide from Mission Control on macOS
    if (process.platform === 'darwin') {
        try {
            mainWindow.setHiddenInMissionControl(true);
        } catch (error) {
            console.warn('Could not hide from Mission Control:', error.message);
        }
    }

    if (process.platform === 'win32') {
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    }

    mainWindow.loadFile(path.join(__dirname, '../index.html'));

    // After window is created, initialize keybinds
    mainWindow.webContents.once('dom-ready', () => {
        setTimeout(() => {
            const defaultKeybinds = getDefaultKeybinds();
            let keybinds = defaultKeybinds;

            // Load keybinds from storage
            const savedKeybinds = storage.getKeybinds();
            if (savedKeybinds) {
                keybinds = { ...defaultKeybinds, ...savedKeybinds };
            }

            updateGlobalShortcuts(keybinds, mainWindow, sendToRenderer, geminiSessionRef);
        }, 150);
    });

    setupWindowIpcHandlers(mainWindow, sendToRenderer, geminiSessionRef);

    return mainWindow;
}

function getDefaultKeybinds() {
    const isMac = process.platform === 'darwin';
    return {
        moveUp: isMac ? 'Alt+Up' : 'Ctrl+Up',
        moveDown: isMac ? 'Alt+Down' : 'Ctrl+Down',
        moveLeft: isMac ? 'Alt+Left' : 'Ctrl+Left',
        moveRight: isMac ? 'Alt+Right' : 'Ctrl+Right',
        toggleVisibility: isMac ? 'Cmd+\\' : 'Ctrl+\\',
        toggleClickThrough: isMac ? 'Cmd+M' : 'Ctrl+M',
        toggleAudioMute: isMac ? 'Cmd+Shift+M' : 'Ctrl+Shift+M',
        nextStep: isMac ? 'Cmd+Enter' : 'Ctrl+Enter',
        previousResponse: isMac ? 'Cmd+[' : 'Ctrl+[',
        nextResponse: isMac ? 'Cmd+]' : 'Ctrl+]',
        scrollUp: isMac ? 'Cmd+Shift+Up' : 'Ctrl+Shift+Up',
        scrollDown: isMac ? 'Cmd+Shift+Down' : 'Ctrl+Shift+Down',
        emergencyErase: isMac ? 'Cmd+Shift+E' : 'Ctrl+Shift+E',
        analyzeScreen: isMac ? 'Cmd+Shift+S' : 'Ctrl+Shift+S',
        searchSelection: isMac ? 'Cmd+Shift+T' : 'Ctrl+Shift+T',
        pushToTalk: isMac ? 'Cmd+Shift+L' : 'Ctrl+Shift+L',
        answerWithContext: isMac ? 'Cmd+Shift+G' : 'Ctrl+Shift+G',
    };
}

// Grab the user's current text selection in any app by simulating a copy,
// reading the clipboard, then restoring the previous clipboard contents.
async function captureSelectedText() {
    const { clipboard } = require('electron');

    if (process.platform === 'darwin') {
        const saved = clipboard.readText();
        try {
            const { execFile } = require('child_process');
            await new Promise((resolve, reject) => {
                execFile(
                    'osascript',
                    ['-e', 'tell application "System Events" to keystroke "c" using command down'],
                    { timeout: 3000 },
                    (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())
                );
            });
            // Give the focused app time to write the selection to the clipboard
            await new Promise(r => setTimeout(r, 250));
            const text = clipboard.readText();
            clipboard.writeText(saved);
            return { success: true, text };
        } catch (err) {
            clipboard.writeText(saved);
            // System Events keystroke requires Accessibility permission
            if (/not allowed|assistive|1002|-1719/i.test(err.message)) {
                return { success: false, error: 'accessibility', text: saved };
            }
            return { success: false, error: err.message, text: saved };
        }
    }

    // Windows/Linux: no keystroke simulation without native deps — use whatever
    // the user already copied
    return { success: true, text: clipboard.readText(), fallback: true };
}

function startClipboardWatcher(mainWindow, sendToRenderer) {
    if (clipboardWatchInterval) return;
    const { clipboard } = require('electron');
    lastClipboardText = clipboard.readText();
    clipboardWatchInterval = setInterval(() => {
        if (!autoSelectionEnabled) return;
        const current = clipboard.readText();
        if (current && current !== lastClipboardText && current.trim().length > 0) {
            lastClipboardText = current;
            if (mainWindow && !mainWindow.isDestroyed()) {
                if (!mainWindow.isVisible()) mainWindow.showInactive();
                sendToRenderer('selection-captured', current.trim());
            }
        }
    }, 400);
}

function stopClipboardWatcher() {
    if (clipboardWatchInterval) {
        clearInterval(clipboardWatchInterval);
        clipboardWatchInterval = null;
    }
    autoSelectionEnabled = false;
}

function updateGlobalShortcuts(keybinds, mainWindow, sendToRenderer, geminiSessionRef) {
    console.log('Updating global shortcuts with:', keybinds);

    // Unregister all existing shortcuts
    globalShortcut.unregisterAll();

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const moveIncrement = Math.floor(Math.min(width, height) * 0.1);

    const movementActions = {
        moveUp: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX, currentY - moveIncrement);
        },
        moveDown: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX, currentY + moveIncrement);
        },
        moveLeft: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX - moveIncrement, currentY);
        },
        moveRight: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX + moveIncrement, currentY);
        },
    };

    Object.keys(movementActions).forEach(action => {
        const keybind = keybinds[action];
        if (keybind) {
            try {
                globalShortcut.register(keybind, movementActions[action]);
                console.log(`Registered ${action}: ${keybind}`);
            } catch (error) {
                console.error(`Failed to register ${action} (${keybind}):`, error);
            }
        }
    });

    // Register toggle visibility shortcut
    if (keybinds.toggleVisibility) {
        try {
            globalShortcut.register(keybinds.toggleVisibility, () => {
                if (mainWindow.isVisible()) {
                    mainWindow.hide();
                } else {
                    mainWindow.showInactive();
                }
            });
            console.log(`Registered toggleVisibility: ${keybinds.toggleVisibility}`);
        } catch (error) {
            console.error(`Failed to register toggleVisibility (${keybinds.toggleVisibility}):`, error);
        }
    }

    // Register toggle click-through shortcut
    if (keybinds.toggleClickThrough) {
        try {
            globalShortcut.register(keybinds.toggleClickThrough, () => {
                mouseEventsIgnored = !mouseEventsIgnored;
                if (mouseEventsIgnored) {
                    mainWindow.setIgnoreMouseEvents(true, { forward: true });
                    console.log('Mouse events ignored');
                } else {
                    mainWindow.setIgnoreMouseEvents(false);
                    console.log('Mouse events enabled');
                }
                mainWindow.webContents.send('click-through-toggled', mouseEventsIgnored);
            });
            console.log(`Registered toggleClickThrough: ${keybinds.toggleClickThrough}`);
        } catch (error) {
            console.error(`Failed to register toggleClickThrough (${keybinds.toggleClickThrough}):`, error);
        }
    }

    // Register toggle audio mute (pause/resume listening) shortcut
    if (keybinds.toggleAudioMute) {
        try {
            globalShortcut.register(keybinds.toggleAudioMute, () => {
                console.log('Toggle audio mute shortcut triggered');
                sendToRenderer('audio-mute-shortcut');
            });
            console.log(`Registered toggleAudioMute: ${keybinds.toggleAudioMute}`);
        } catch (error) {
            console.error(`Failed to register toggleAudioMute (${keybinds.toggleAudioMute}):`, error);
        }
    }

    // Register next step shortcut (either starts session or takes screenshot based on view)
    if (keybinds.nextStep) {
        try {
            globalShortcut.register(keybinds.nextStep, async () => {
                console.log('Next step shortcut triggered');
                try {
                    // Determine the shortcut key format
                    const isMac = process.platform === 'darwin';
                    const shortcutKey = isMac ? 'cmd+enter' : 'ctrl+enter';

                    // Use the new handleShortcut function
                    mainWindow.webContents.executeJavaScript(`
                        cheatingDaddy.handleShortcut('${shortcutKey}');
                    `);
                } catch (error) {
                    console.error('Error handling next step shortcut:', error);
                }
            });
            console.log(`Registered nextStep: ${keybinds.nextStep}`);
        } catch (error) {
            console.error(`Failed to register nextStep (${keybinds.nextStep}):`, error);
        }
    }

    // Register previous response shortcut
    if (keybinds.previousResponse) {
        try {
            globalShortcut.register(keybinds.previousResponse, () => {
                console.log('Previous response shortcut triggered');
                sendToRenderer('navigate-previous-response');
            });
            console.log(`Registered previousResponse: ${keybinds.previousResponse}`);
        } catch (error) {
            console.error(`Failed to register previousResponse (${keybinds.previousResponse}):`, error);
        }
    }

    // Register next response shortcut
    if (keybinds.nextResponse) {
        try {
            globalShortcut.register(keybinds.nextResponse, () => {
                console.log('Next response shortcut triggered');
                sendToRenderer('navigate-next-response');
            });
            console.log(`Registered nextResponse: ${keybinds.nextResponse}`);
        } catch (error) {
            console.error(`Failed to register nextResponse (${keybinds.nextResponse}):`, error);
        }
    }

    // Register scroll up shortcut
    if (keybinds.scrollUp) {
        try {
            globalShortcut.register(keybinds.scrollUp, () => {
                console.log('Scroll up shortcut triggered');
                sendToRenderer('scroll-response-up');
            });
            console.log(`Registered scrollUp: ${keybinds.scrollUp}`);
        } catch (error) {
            console.error(`Failed to register scrollUp (${keybinds.scrollUp}):`, error);
        }
    }

    // Register scroll down shortcut
    if (keybinds.scrollDown) {
        try {
            globalShortcut.register(keybinds.scrollDown, () => {
                console.log('Scroll down shortcut triggered');
                sendToRenderer('scroll-response-down');
            });
            console.log(`Registered scrollDown: ${keybinds.scrollDown}`);
        } catch (error) {
            console.error(`Failed to register scrollDown (${keybinds.scrollDown}):`, error);
        }
    }

    // Register analyze-screen shortcut (works from any view, shows window if hidden)
    if (keybinds.analyzeScreen) {
        try {
            globalShortcut.register(keybinds.analyzeScreen, () => {
                console.log('Analyze screen shortcut triggered');
                try {
                    if (!mainWindow.isVisible()) {
                        mainWindow.showInactive();
                    }
                    mainWindow.webContents.executeJavaScript(`
                        cheatingDaddy.handleShortcut('analyze-screen');
                    `);
                } catch (error) {
                    console.error('Error handling analyze screen shortcut:', error);
                }
            });
            console.log(`Registered analyzeScreen: ${keybinds.analyzeScreen}`);
        } catch (error) {
            console.error(`Failed to register analyzeScreen (${keybinds.analyzeScreen}):`, error);
        }
    }

    // Register selected-text search shortcut
    if (keybinds.searchSelection) {
        try {
            globalShortcut.register(keybinds.searchSelection, async () => {
                console.log('Search selection shortcut triggered');
                try {
                    const result = await captureSelectedText();
                    if (result.error === 'accessibility') {
                        sendToRenderer(
                            'update-status',
                            'Grant Accessibility permission to alpha (System Settings → Privacy & Security → Accessibility) to capture selected text'
                        );
                        // Fall through with clipboard contents as a fallback
                    }
                    if (!result.text || !result.text.trim()) {
                        sendToRenderer('update-status', 'No text selected or in clipboard');
                        return;
                    }
                    if (!mainWindow.isVisible()) {
                        mainWindow.showInactive();
                    }
                    sendToRenderer('selection-captured', result.text.trim());
                } catch (error) {
                    console.error('Error handling search selection shortcut:', error);
                }
            });
            console.log(`Registered searchSelection: ${keybinds.searchSelection}`);
        } catch (error) {
            console.error(`Failed to register searchSelection (${keybinds.searchSelection}):`, error);
        }
    }

    // Register push-to-talk shortcut (ask a question by voice; shows window if hidden)
    if (keybinds.pushToTalk) {
        try {
            globalShortcut.register(keybinds.pushToTalk, () => {
                console.log('Push-to-talk shortcut triggered');
                try {
                    if (!mainWindow.isVisible()) {
                        mainWindow.showInactive();
                    }
                    sendToRenderer('push-to-talk-shortcut');
                } catch (error) {
                    console.error('Error handling push-to-talk shortcut:', error);
                }
            });
            if (globalShortcut.isRegistered(keybinds.pushToTalk)) {
                console.log(`Registered pushToTalk: ${keybinds.pushToTalk}`);
            } else {
                console.warn(
                    `Could not register pushToTalk (${keybinds.pushToTalk}) — likely taken by another app. Rebind it in Customize.`
                );
                sendToRenderer(
                    'update-status',
                    `Push-to-talk shortcut ${keybinds.pushToTalk} is unavailable (in use by another app) — rebind it in Customize.`
                );
            }
        } catch (error) {
            console.error(`Failed to register pushToTalk (${keybinds.pushToTalk}):`, error);
        }
    }

    // Register answer-with-context shortcut: force Claude to answer the recently
    // heard speech (even if it was out of context / not auto-answered).
    if (keybinds.answerWithContext) {
        try {
            globalShortcut.register(keybinds.answerWithContext, () => {
                console.log('Answer-with-context shortcut triggered');
                try {
                    if (!mainWindow.isVisible()) {
                        mainWindow.showInactive();
                    }
                    sendToRenderer('answer-with-context-shortcut');
                } catch (error) {
                    console.error('Error handling answer-with-context shortcut:', error);
                }
            });
            // register() returns false (no throw) when another app already owns
            // the combo — surface that so it isn't silently dead.
            if (globalShortcut.isRegistered(keybinds.answerWithContext)) {
                console.log(`Registered answerWithContext: ${keybinds.answerWithContext}`);
            } else {
                console.warn(
                    `Could not register answerWithContext (${keybinds.answerWithContext}) — likely taken by another app. Rebind it in Customize.`
                );
            }
        } catch (error) {
            console.error(`Failed to register answerWithContext (${keybinds.answerWithContext}):`, error);
        }
    }

    // Register emergency erase shortcut
    if (keybinds.emergencyErase) {
        try {
            globalShortcut.register(keybinds.emergencyErase, () => {
                console.log('Emergency Erase triggered!');
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.hide();

                    if (geminiSessionRef.current) {
                        geminiSessionRef.current.close();
                        geminiSessionRef.current = null;
                    }

                    sendToRenderer('clear-sensitive-data');

                    setTimeout(() => {
                        const { app } = require('electron');
                        app.quit();
                    }, 300);
                }
            });
            console.log(`Registered emergencyErase: ${keybinds.emergencyErase}`);
        } catch (error) {
            console.error(`Failed to register emergencyErase (${keybinds.emergencyErase}):`, error);
        }
    }
}

function setupWindowIpcHandlers(mainWindow, sendToRenderer, geminiSessionRef) {
    ipcMain.on('session-state-changed', (event, active) => {
        if (active) {
            autoSelectionEnabled = true;
            startClipboardWatcher(mainWindow, sendToRenderer);
        } else {
            stopClipboardWatcher();
        }
    });

    ipcMain.on('view-changed', (event, view) => {
        if (!mainWindow.isDestroyed()) {
            if (view !== 'assistant') {
                mainWindow.setIgnoreMouseEvents(false);
            }
        }
    });

    ipcMain.handle('window-minimize', () => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.minimize();
        }
    });

    ipcMain.on('update-keybinds', (event, newKeybinds) => {
        if (!mainWindow.isDestroyed()) {
            updateGlobalShortcuts(newKeybinds, mainWindow, sendToRenderer, geminiSessionRef);
        }
    });

    ipcMain.handle('toggle-window-visibility', async event => {
        try {
            if (mainWindow.isDestroyed()) {
                return { success: false, error: 'Window has been destroyed' };
            }

            if (mainWindow.isVisible()) {
                mainWindow.hide();
            } else {
                mainWindow.showInactive();
            }
            return { success: true };
        } catch (error) {
            console.error('Error toggling window visibility:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    createWindow,
    getDefaultKeybinds,
    updateGlobalShortcuts,
    setupWindowIpcHandlers,
    stopClipboardWatcher,
};
