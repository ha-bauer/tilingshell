import { GLib, Meta } from '../../gi/ext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import SignalHandling from '../../utils/signalHandling';
import Settings from '../../settings/settings';
import { logger } from '../../utils/logger';
import { maximizeWindow, unmaximizeWindow } from '../../utils/gnomesupport';
import Tile from '../layout/Tile';
import ExtendedWindow from '../tilingsystem/extendedWindow';
import { TilingManager } from '../tilingsystem/tilingManager';

const debug = logger('WindowPlacementRestorer');

// how long a window must keep the same position and size before it is recorded
const RECORD_DELAY_MS = 1000;
// how long to wait after a monitors change before restoring, so that
// mutter has finished relocating the windows on its own
const RESTORE_DELAY_MS = 1500;
// relative difference under which two placements are considered equal
const PLACEMENT_TOLERANCE = 0.005;

interface WindowPlacement {
    monitorKey: string;
    // position and size relative to the monitor's work area (0 to 1)
    x: number;
    y: number;
    width: number;
    height: number;
    maximized: boolean;
    fullscreen: boolean;
    tile: Tile | undefined;
}

// Placements are kept at module level, so they survive the extension being
// disabled while the screen is locked. Windows are identified by their id,
// which is unique within the session.
const placements: Map<number, WindowPlacement> = new Map();

function monitorKeyOf(monitor: Meta.Monitor): string {
    const serial = monitor.get_serial();
    if (serial && serial !== 'unknown')
        return `${monitor.get_vendor()}|${monitor.get_product()}|${serial}`;
    return `connector|${monitor.get_connector()}`;
}

/**
 * Restores position, size and tile of windows when a display is turned off
 * and on again (or disconnected and reconnected).
 *
 * Mutter relocates the windows of a disappearing monitor and moves some of
 * them back when the monitor reappears, but without their previous position
 * and size. This manager records the last stable placement of every window,
 * keyed by a stable monitor identity (vendor, product and serial), and after
 * every monitors change it moves the windows back to the recorded placement.
 */
export class WindowPlacementRestorer {
    private readonly _signals: SignalHandling;
    private readonly _activeSignals: SignalHandling;
    private readonly _getTilingManager: (
        monitorIndex: number,
    ) => TilingManager | undefined;

    // window id -> ids of the signals connected on that window
    private readonly _windowSignals: Map<
        number,
        { win: Meta.Window; ids: number[] }
    >;

    private readonly _recordTimers: Map<number, number>;
    private readonly _pendingUserActions: Set<number>;
    private _restoreTimer: number;
    private _recordingSuspended: boolean;
    private _active: boolean;
    // monitor index -> monitor key
    private _monitorKeys: string[];

    constructor(
        getTilingManager: (monitorIndex: number) => TilingManager | undefined,
    ) {
        this._signals = new SignalHandling();
        this._activeSignals = new SignalHandling();
        this._getTilingManager = getTilingManager;
        this._windowSignals = new Map();
        this._recordTimers = new Map();
        this._pendingUserActions = new Set();
        this._restoreTimer = 0;
        this._recordingSuspended = false;
        this._active = false;
        this._monitorKeys = [];
    }

    public static isSupported(): boolean {
        const monitorManager = global.backend?.get_monitor_manager?.();
        return (
            !!monitorManager &&
            typeof monitorManager.get_logical_monitors === 'function'
        );
    }

    public enable(): void {
        if (!WindowPlacementRestorer.isSupported()) {
            debug('not supported on this version of GNOME Shell');
            return;
        }

        if (Settings.RESTORE_WINDOW_PLACEMENT) this._turnOn();
        this._signals.connect(
            Settings,
            Settings.KEY_RESTORE_WINDOW_PLACEMENT,
            () => {
                if (Settings.RESTORE_WINDOW_PLACEMENT) this._turnOn();
                else this._turnOff(true);
            },
        );
    }

    public destroy(): void {
        // keep the recorded placements if the extension is disabled because
        // the screen is locked: the monitor may be turned off and on again
        // while the screen is locked
        const isLocked = Main.sessionMode.isLocked;
        this._turnOff(!isLocked);
        this._signals.disconnect();
    }

    private _turnOn() {
        if (this._active) return;
        this._active = true;

        this._updateMonitorKeys();
        this._allWindows().forEach((win) => this._trackWindow(win));

        this._activeSignals.connect(
            global.display,
            'window-created',
            (_display: Meta.Display, window: Meta.Window) => {
                if (!this._isRelevant(window)) return;
                this._trackWindow(window);
                this._scheduleRecord(window);
            },
        );
        this._activeSignals.connect(
            global.display,
            'grab-op-end',
            (_display: Meta.Display, window: Meta.Window) => {
                // a grab is always a user action: record even if the
                // window's monitor is currently missing
                if (window && this._windowSignals.has(window.get_id()))
                    this._scheduleRecord(window, true);
            },
        );
        this._activeSignals.connect(
            Main.layoutManager,
            'monitors-changed',
            this._onMonitorsChanged.bind(this),
        );

        // windows may have been relocated while the extension was disabled
        // (e.g. the monitor was turned off while the screen was locked),
        // so restore before recording anything new
        this._recordingSuspended = true;
        this._scheduleRestore();
    }

    private _turnOff(forgetPlacements: boolean) {
        if (!this._active) return;
        this._active = false;

        if (this._restoreTimer) GLib.source_remove(this._restoreTimer);
        this._restoreTimer = 0;
        this._cancelPendingRecords();
        this._windowSignals.forEach(({ win, ids }) =>
            ids.forEach((id) => win.disconnect(id)),
        );
        this._windowSignals.clear();
        this._activeSignals.disconnect();

        if (forgetPlacements) placements.clear();
    }

    private _allWindows(): Meta.Window[] {
        return global.display
            .get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .filter((win) => this._isRelevant(win));
    }

    private _isRelevant(window: Meta.Window): boolean {
        return (
            !!window &&
            window.get_window_type() === Meta.WindowType.NORMAL &&
            !window.get_transient_for()
        );
    }

    private _trackWindow(window: Meta.Window) {
        const winId = window.get_id();
        if (this._windowSignals.has(winId)) return;

        const ids = [
            window.connect('position-changed', () =>
                this._scheduleRecord(window),
            ),
            window.connect('size-changed', () => this._scheduleRecord(window)),
            window.connect('unmanaged', () => {
                const timer = this._recordTimers.get(winId);
                if (timer) GLib.source_remove(timer);
                this._recordTimers.delete(winId);
                this._pendingUserActions.delete(winId);
                this._windowSignals
                    .get(winId)
                    ?.ids.forEach((id) => window.disconnect(id));
                this._windowSignals.delete(winId);
                placements.delete(winId);
            }),
        ];
        this._windowSignals.set(winId, { win: window, ids });
    }

    private _scheduleRecord(window: Meta.Window, userAction = false) {
        if (this._recordingSuspended) return;

        const winId = window.get_id();
        const previous = this._recordTimers.get(winId);
        if (previous) GLib.source_remove(previous);
        // a pending user action must not be lost when the window keeps
        // moving a bit after the grab ended
        if (userAction) this._pendingUserActions.add(winId);

        const timer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            RECORD_DELAY_MS,
            () => {
                this._recordTimers.delete(winId);
                const isUserAction = this._pendingUserActions.delete(winId);
                if (!this._recordingSuspended)
                    this._record(window, isUserAction);
                return GLib.SOURCE_REMOVE;
            },
        );
        this._recordTimers.set(winId, timer);
    }

    private _cancelPendingRecords() {
        this._recordTimers.forEach((timer) => GLib.source_remove(timer));
        this._recordTimers.clear();
        this._pendingUserActions.clear();
    }

    private _record(window: Meta.Window, userAction: boolean) {
        const placement = this._currentPlacement(window);
        if (!placement) return;

        const winId = window.get_id();
        const recorded = placements.get(winId);
        // The window was moved away from a monitor which is now missing.
        // Unless the user explicitly moved, tiled or untiled it, this is a
        // side effect of the missing monitor (e.g. the app resized itself),
        // so keep the placement on the missing monitor.
        if (
            recorded &&
            !userAction &&
            !this._monitorKeys.includes(recorded.monitorKey) &&
            this._sameTile(recorded.tile, placement.tile)
        )
            return;

        placements.set(winId, placement);
    }

    private _currentPlacement(
        window: Meta.Window,
    ): WindowPlacement | undefined {
        const monitorIndex = window.get_monitor();
        const monitorKey = this._monitorKeys[monitorIndex];
        if (monitorIndex < 0 || !monitorKey) return undefined;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        if (workArea.width <= 0 || workArea.height <= 0) return undefined;

        const rect = window.get_frame_rect();
        const tile = (window as ExtendedWindow).assignedTile;
        return {
            monitorKey,
            x: (rect.x - workArea.x) / workArea.width,
            y: (rect.y - workArea.y) / workArea.height,
            width: rect.width / workArea.width,
            height: rect.height / workArea.height,
            maximized:
                window.maximizedHorizontally && window.maximizedVertically,
            fullscreen: window.is_fullscreen(),
            tile: tile ? new Tile({ ...tile }) : undefined,
        };
    }

    private _updateMonitorKeys() {
        const keys: string[] = [];
        const logicalMonitors =
            global.backend.get_monitor_manager().get_logical_monitors() ?? [];
        logicalMonitors.forEach((logicalMonitor) => {
            const monitors = logicalMonitor.get_monitors();
            if (monitors.length === 0) return;
            keys[logicalMonitor.get_number()] = monitorKeyOf(monitors[0]);
        });
        this._monitorKeys = keys;
        debug(`monitors: ${keys.join(', ')}`);
    }

    private _onMonitorsChanged() {
        // windows are being relocated by mutter: do not record that
        this._recordingSuspended = true;
        this._cancelPendingRecords();
        this._updateMonitorKeys();
        this._scheduleRestore();
    }

    private _scheduleRestore() {
        if (this._restoreTimer) GLib.source_remove(this._restoreTimer);
        this._restoreTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            RESTORE_DELAY_MS,
            () => {
                this._restoreTimer = 0;
                this._restore();
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    private _restore() {
        this._updateMonitorKeys();

        const windows = this._allWindows();
        // forget windows which were closed while the extension was disabled
        const existingIds = new Set(windows.map((win) => win.get_id()));
        [...placements.keys()]
            .filter((winId) => !existingIds.has(winId))
            .forEach((winId) => placements.delete(winId));

        windows.forEach((window) => {
            this._trackWindow(window);
            const placement = placements.get(window.get_id());
            if (placement) this._restoreWindow(window, placement);
        });

        this._recordingSuspended = false;
        // record the windows we know nothing about yet
        windows
            .filter((win) => !placements.has(win.get_id()))
            .forEach((win) => this._record(win, false));
    }

    private _restoreWindow(window: Meta.Window, placement: WindowPlacement) {
        const monitorIndex = this._monitorKeys.indexOf(placement.monitorKey);
        // the monitor of the window is still missing
        if (monitorIndex < 0) return;

        const current = this._currentPlacement(window);
        if (current && this._samePlacement(current, placement)) return;

        debug(
            `restoring "${window.get_title()}" on monitor ${monitorIndex} (${placement.monitorKey})`,
        );

        if (placement.fullscreen) {
            window.move_to_monitor(monitorIndex);
            return;
        }

        if (placement.maximized) {
            if (window.maximizedHorizontally || window.maximizedVertically)
                unmaximizeWindow(window);
            window.move_to_monitor(monitorIndex);
            maximizeWindow(window);
            return;
        }

        if (window.maximizedHorizontally || window.maximizedVertically)
            unmaximizeWindow(window);

        const tilingManager = this._getTilingManager(monitorIndex);
        if (placement.tile && tilingManager) {
            tilingManager.onRestoreWindowToTile(placement.tile, window);
            return;
        }

        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        window.move_to_monitor(monitorIndex);
        window.move_resize_frame(
            false,
            Math.round(workArea.x + placement.x * workArea.width),
            Math.round(workArea.y + placement.y * workArea.height),
            Math.round(placement.width * workArea.width),
            Math.round(placement.height * workArea.height),
        );
    }

    private _samePlacement(a: WindowPlacement, b: WindowPlacement): boolean {
        if (a.monitorKey !== b.monitorKey) return false;
        if (a.maximized !== b.maximized || a.fullscreen !== b.fullscreen)
            return false;
        if (a.maximized || a.fullscreen) return true;
        return (
            Math.abs(a.x - b.x) < PLACEMENT_TOLERANCE &&
            Math.abs(a.y - b.y) < PLACEMENT_TOLERANCE &&
            Math.abs(a.width - b.width) < PLACEMENT_TOLERANCE &&
            Math.abs(a.height - b.height) < PLACEMENT_TOLERANCE
        );
    }

    private _sameTile(a: Tile | undefined, b: Tile | undefined): boolean {
        if (!a || !b) return a === b;
        return (
            a.x === b.x &&
            a.y === b.y &&
            a.width === b.width &&
            a.height === b.height
        );
    }
}
