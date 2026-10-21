import { registerGObjectClass } from '../utils/gjs';
import Layout from '../components/layout/Layout';
import Settings from '../settings/settings';
import SignalHandling from './signalHandling';
import { GObject, Meta, Gio } from '../gi/ext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { logger } from './logger';
import { getWindows } from './ui';
import ExtendedWindow from '../components/tilingsystem/extendedWindow';

const debug = logger('GlobalState');

export default class GlobalState extends GObject.Object {
    static { registerGObjectClass(this, {
        GTypeName: 'GlobalState',
        Signals: {
            'layouts-changed': {
                param_types: [],
            },
            'adjusted-layouts-changed': {
                param_types: [],
            },
        },
        Properties: {
            tilePreviewAnimationTime: GObject.ParamSpec.uint(
                'tilePreviewAnimationTime',
                'tilePreviewAnimationTime',
                'Animation time of tile previews in milliseconds',
                GObject.ParamFlags.READWRITE,
                0,
                2000,
                100,
            ),
        },
    })};

    public static SIGNAL_LAYOUTS_CHANGED = 'layouts-changed';
    public static SIGNAL_ADJUSTED_LAYOUTS_CHANGED = 'adjusted-layouts-changed';

    private static _instance: GlobalState | null;

    private _signals: SignalHandling;
    private _layouts: Layout[];
    private _tilePreviewAnimationTime: number;
    // if workspaces are reordered, we use this map to know which layouts where selected
    // to each workspace and we save the new ordering in the settings
    private _selected_layouts: Map<Meta.Workspace, string[]>; // used to handle reordering of workspaces
    // runtime-only copies of the selected layouts whose tile borders were moved
    // by resizing tiled windows together, keyed by "monitorIndex:workspaceIndex"
    private _adjustedLayouts: Map<string, Layout>;

    static get(): GlobalState {
        if (!this._instance) this._instance = new GlobalState();

        return this._instance;
    }

    static destroy() {
        if (this._instance) {
            this._instance._signals.disconnect();
            this._instance._layouts = [];
            this._instance = null;
        }
    }

    constructor() {
        super();

        this._signals = new SignalHandling();
        this._layouts = Settings.get_layouts_json();
        this._tilePreviewAnimationTime = 100;
        this._selected_layouts = new Map();
        this._adjustedLayouts = new Map();
        this.validate_selected_layouts();

        Settings.bind(
            Settings.KEY_TILE_PREVIEW_ANIMATION_TIME,
            this,
            'tilePreviewAnimationTime',
            Gio.SettingsBindFlags.GET,
        );
        this._signals.connect(
            Settings,
            Settings.KEY_SETTING_LAYOUTS_JSON,
            () => {
                this._layouts = Settings.get_layouts_json();
                this._adjustedLayouts.clear();
                this.emit(GlobalState.SIGNAL_LAYOUTS_CHANGED);
            },
        );

        this._signals.connect(
            Settings,
            Settings.KEY_SETTING_SELECTED_LAYOUTS,
            () => {
                const selected_layouts = Settings.get_selected_layouts();
                if (selected_layouts.length === 0) {
                    this.validate_selected_layouts();
                    return;
                }

                const defaultLayout: Layout = this._layouts[0];
                const n_monitors = Main.layoutManager.monitors.length;
                const n_workspaces = global.workspaceManager.get_n_workspaces();
                for (let i = 0; i < n_workspaces; i++) {
                    const ws =
                        global.workspaceManager.get_workspace_by_index(i);
                    if (!ws) continue;

                    const monitors_layouts =
                        i < selected_layouts.length
                            ? selected_layouts[i]
                            : [defaultLayout.id];
                    while (monitors_layouts.length < n_monitors)
                        monitors_layouts.push(defaultLayout.id);
                    while (monitors_layouts.length > n_monitors)
                        monitors_layouts.pop();

                    this._selected_layouts.set(ws, monitors_layouts);
                }
            },
        );

        this._signals.connect(
            global.workspaceManager,
            'workspace-added',
            (_, index: number) => {
                const n_workspaces = global.workspaceManager.get_n_workspaces();
                const newWs =
                    global.workspaceManager.get_workspace_by_index(index);
                if (!newWs) return;

                debug(`added workspace ${index}`);

                const secondLastWs =
                    global.workspaceManager.get_workspace_by_index(
                        n_workspaces - 2,
                    );

                // the new workspace must start with the same layout of the last workspace
                // use the layout at index 0 if for some reason we cannot find the layout
                // of the last workspace
                const secondLastWsLayoutsId = secondLastWs
                    ? (this._selected_layouts.get(secondLastWs) ?? [])
                    : [];
                if (secondLastWsLayoutsId.length === 0) {
                    secondLastWsLayoutsId.push(
                        ...Main.layoutManager.monitors.map(
                            () => this._layouts[0].id,
                        ),
                    );
                }

                this._selected_layouts.set(
                    newWs,
                    secondLastWsLayoutsId, // Main.layoutManager.monitors.map(() => layout.id),
                );

                const to_be_saved: string[][] = [];
                for (let i = 0; i < n_workspaces; i++) {
                    const ws =
                        global.workspaceManager.get_workspace_by_index(i);
                    if (!ws) continue;
                    const monitors_layouts = this._selected_layouts.get(ws);
                    if (!monitors_layouts) continue;
                    to_be_saved.push(monitors_layouts);
                }

                Settings.save_selected_layouts(to_be_saved);
            },
        );

        this._signals.connect(
            global.workspaceManager,
            'workspace-removed',
            () => {
                const newMap: Map<Meta.Workspace, string[]> = new Map();
                const n_workspaces = global.workspaceManager.get_n_workspaces();
                const to_be_saved: string[][] = [];
                for (let i = 0; i < n_workspaces; i++) {
                    const ws =
                        global.workspaceManager.get_workspace_by_index(i);
                    if (!ws) continue;
                    const monitors_layouts = this._selected_layouts.get(ws);
                    if (!monitors_layouts) continue;

                    this._selected_layouts.delete(ws);
                    newMap.set(ws, monitors_layouts);
                    to_be_saved.push(monitors_layouts);
                }
                Settings.save_selected_layouts(to_be_saved);

                this._selected_layouts.clear();
                this._selected_layouts = newMap;
                this._clearAdjustedLayouts();
                debug('deleted workspace');
            },
        );

        this._signals.connect(
            global.workspaceManager,
            'workspaces-reordered',
            () => {
                this._clearAdjustedLayouts();
                this._save_selected_layouts();
                debug('reordered workspaces');
            },
        );
    }

    public validate_selected_layouts() {
        const n_monitors = Main.layoutManager.monitors.length;
        const old_selected_layouts = Settings.get_selected_layouts();
        for (let i = 0; i < global.workspaceManager.get_n_workspaces(); i++) {
            const ws = global.workspaceManager.get_workspace_by_index(i);
            if (!ws) continue;

            const monitors_layouts =
                i < old_selected_layouts.length ? old_selected_layouts[i] : [];
            while (monitors_layouts.length < n_monitors)
                monitors_layouts.push(this._layouts[0].id);
            while (monitors_layouts.length > n_monitors) monitors_layouts.pop();

            monitors_layouts.forEach((_, ind) => {
                if (
                    this._layouts.findIndex(
                        (lay) => lay.id === monitors_layouts[ind],
                    ) === -1
                )
                    monitors_layouts[ind] = monitors_layouts[0];
            });

            this._selected_layouts.set(ws, monitors_layouts);
        }

        this._save_selected_layouts();
    }

    private _save_selected_layouts() {
        const to_be_saved: string[][] = [];
        const n_workspaces = global.workspaceManager.get_n_workspaces();
        for (let i = 0; i < n_workspaces; i++) {
            const ws = global.workspaceManager.get_workspace_by_index(i);
            if (!ws) continue;
            const monitors_layouts = this._selected_layouts.get(ws);
            if (!monitors_layouts) continue;
            to_be_saved.push(monitors_layouts);
        }

        Settings.save_selected_layouts(to_be_saved);
    }

    get layouts(): Layout[] {
        return this._layouts;
    }

    public addLayout(newLay: Layout) {
        this._layouts.push(newLay);
        // easy way to trigger save and signal emission
        this.layouts = this._layouts;
    }

    public deleteLayout(layoutToDelete: Layout) {
        const layFoundIndex = this._layouts.findIndex(
            (lay) => lay.id === layoutToDelete.id,
        );
        if (layFoundIndex === -1) return;

        this._layouts.splice(layFoundIndex, 1);

        // easy way to trigger a save and emit layouts-changed signal
        this.layouts = this._layouts;

        this._selected_layouts.forEach((monitors_selected) => {
            if (
                layoutToDelete.id ===
                monitors_selected[Main.layoutManager.primaryIndex]
            ) {
                monitors_selected[Main.layoutManager.primaryIndex] =
                    this._layouts[0].id;
                this._save_selected_layouts();
            }
        });
    }

    public editLayout(newLay: Layout) {
        const layFoundIndex = this._layouts.findIndex(
            (lay) => lay.id === newLay.id,
        );
        if (layFoundIndex === -1) return;

        this._layouts[layFoundIndex] = newLay;
        // easy way to trigger save and signal emission
        this.layouts = this._layouts;
    }

    public swapLayouts(first: number, second: number) {
        const tmp = this._layouts[first];
        this._layouts[first] = this._layouts[second];
        this._layouts[second] = tmp;
        // easy way to trigger save and signal emission
        this.layouts = this._layouts;
    }

    set layouts(layouts: Layout[]) {
        this._layouts = layouts;
        this._adjustedLayouts.clear();
        Settings.save_layouts_json(layouts);
        this.emit(GlobalState.SIGNAL_LAYOUTS_CHANGED);
    }

    /**
     * Stores a copy of the selected layout of the given monitor and workspace
     * whose tiles were adjusted at runtime (e.g. by resizing tiled windows
     * together). It is returned by getSelectedLayoutOfMonitor until another
     * layout is selected or the layouts are edited.
     */
    public setAdjustedLayoutOfMonitor(
        layout: Layout,
        monitorIndex: number,
        workspaceIndex: number,
    ) {
        this._adjustedLayouts.set(`${monitorIndex}:${workspaceIndex}`, layout);
        this.emit(GlobalState.SIGNAL_ADJUSTED_LAYOUTS_CHANGED);
    }

    private _clearAdjustedLayouts(monitorIndex?: number) {
        if (this._adjustedLayouts.size === 0) return;

        if (monitorIndex === undefined) {
            this._adjustedLayouts.clear();
        } else {
            [...this._adjustedLayouts.keys()]
                .filter((key) => key.startsWith(`${monitorIndex}:`))
                .forEach((key) => this._adjustedLayouts.delete(key));
        }
        this.emit(GlobalState.SIGNAL_ADJUSTED_LAYOUTS_CHANGED);
    }

    public getSelectedLayoutOfMonitor(
        monitorIndex: number,
        workspaceIndex: number,
    ): Layout {
        const selectedLayouts = Settings.get_selected_layouts();
        if (workspaceIndex < 0 || workspaceIndex >= selectedLayouts.length)
            workspaceIndex = 0;

        const monitors_selected =
            workspaceIndex < selectedLayouts.length
                ? selectedLayouts[workspaceIndex]
                : GlobalState.get().layouts[0].id;
        if (monitorIndex < 0 || monitorIndex >= monitors_selected.length)
            monitorIndex = 0;

        const selectedLayout =
            this._layouts.find(
                (lay) => lay.id === monitors_selected[monitorIndex],
            ) || this._layouts[0];
        const adjustedLayout = this._adjustedLayouts.get(
            `${monitorIndex}:${workspaceIndex}`,
        );
        return adjustedLayout && adjustedLayout.id === selectedLayout.id
            ? adjustedLayout
            : selectedLayout;
    }

    public get tilePreviewAnimationTime(): number {
        return this._tilePreviewAnimationTime;
    }

    public set tilePreviewAnimationTime(value: number) {
        this._tilePreviewAnimationTime = value;
    }

    public setSelectedLayoutOfMonitor(
        layoutToSelectId: string,
        monitorIndex: number,
    ) {
        // selecting a layout (even the same one again) restores its original tiles
        this._clearAdjustedLayouts(monitorIndex);

        const selected = Settings.get_selected_layouts();

        if (Settings.SYNC_LAYOUT_ACROSS_WORKSPACES) {
            for (let i = 0; i < selected.length; i++) {
                selected[i][monitorIndex] = layoutToSelectId;
            }
        } else {
            selected[global.workspaceManager.get_active_workspace_index()][
                monitorIndex
            ] = layoutToSelectId;

            const n_workspaces = global.workspaceManager.get_n_workspaces();
            if (
                global.workspaceManager.get_active_workspace_index() ===
                n_workspaces - 2
            ) {
                const lastWs = global.workspaceManager.get_workspace_by_index(
                    n_workspaces - 1,
                );
                if (!lastWs) return;

                const tiledWindows = getWindows(lastWs).find(
                    (win) =>
                        (win as ExtendedWindow).assignedTile &&
                        win.get_monitor() === monitorIndex,
                );
                if (!tiledWindows) {
                    selected[lastWs.index()][monitorIndex] = layoutToSelectId;
                }
            }
        }

        Settings.save_selected_layouts(selected);
    }
}
