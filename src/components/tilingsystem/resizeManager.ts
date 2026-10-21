import { St, Mtk, Meta } from '../../gi/ext';
import SignalHandling from '../../utils/signalHandling';
import Settings from '../../settings/settings';
import ExtendedWindow from './extendedWindow';
import { getWindows } from '../../utils/ui';
import GlobalState from '../../utils/globalState';
import Layout from '../layout/Layout';
import Tile from '../layout/Tile';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// a tile border moved by resizing tiled windows together.
// "value" is the border position along "axis", "from"/"to" is its extent
// along the other axis. Everything is relative to the work area
interface MovedBorder {
    axis: 'x' | 'y';
    oldValue: number;
    newValue: number;
    from: number;
    to: number;
}

// tolerance used to compare tile borders, relative to the work area
const BORDER_TOLERANCE = 0.005;

const isOnWorkAreaEdge = (value: number) =>
    Math.abs(value) < BORDER_TOLERANCE || Math.abs(value - 1) < BORDER_TOLERANCE;

const rangesOverlap = (
    [fromA, toA]: [number, number],
    [fromB, toB]: [number, number],
) => Math.min(toA, toB) - Math.max(fromA, fromB) > BORDER_TOLERANCE;

export class ResizingManager {
    private _signals: SignalHandling | null;
    // windows resized together and their frame before resizing
    private _jointResize: [Meta.Window, Mtk.Rectangle][] | null;

    constructor() {
        this._signals = null;
        this._jointResize = null;
    }

    public enable() {
        if (this._signals) this._signals.disconnect();
        this._signals = new SignalHandling();

        this._signals.connect(
            global.display,
            'grab-op-begin',
            (
                _display: Meta.Display,
                window: Meta.Window,
                grabOp: Meta.GrabOp,
            ) => {
                const moving =
                    grabOp === Meta.GrabOp.KEYBOARD_MOVING ||
                    grabOp === Meta.GrabOp.MOVING;
                if (moving || !Settings.RESIZE_COMPLEMENTING_WINDOWS) return;

                this._onWindowResizingBegin(window, grabOp & ~1024);
            },
        );

        this._signals.connect(
            global.display,
            'grab-op-end',
            (
                _display: Meta.Display,
                window: Meta.Window,
                grabOp: Meta.GrabOp,
            ) => {
                const moving =
                    grabOp === Meta.GrabOp.KEYBOARD_MOVING ||
                    grabOp === Meta.GrabOp.MOVING;
                if (moving) return;

                this._onWindowResizingEnd(window);
            },
        );
    }

    public destroy() {
        if (this._signals) this._signals.disconnect();
    }

    private _onWindowResizingBegin(window: Meta.Window, grabOp: Meta.GrabOp) {
        if (
            !window ||
            !(window as ExtendedWindow).assignedTile ||
            !this._signals
        )
            return;

        const verticalSide: [boolean, St.Side] = [false, 0];
        const horizontalSide: [boolean, St.Side] = [false, 0];
        switch (grabOp) {
            case Meta.GrabOp.RESIZING_N:
            case Meta.GrabOp.RESIZING_NE:
            case Meta.GrabOp.RESIZING_NW:
            case Meta.GrabOp.KEYBOARD_RESIZING_N:
            case Meta.GrabOp.KEYBOARD_RESIZING_NE:
            case Meta.GrabOp.KEYBOARD_RESIZING_NW:
                verticalSide[0] = true;
                verticalSide[1] = St.Side.TOP;
                break;
            case Meta.GrabOp.RESIZING_S:
            case Meta.GrabOp.RESIZING_SE:
            case Meta.GrabOp.RESIZING_SW:
            case Meta.GrabOp.KEYBOARD_RESIZING_S:
            case Meta.GrabOp.KEYBOARD_RESIZING_SE:
            case Meta.GrabOp.KEYBOARD_RESIZING_SW:
                verticalSide[0] = true;
                verticalSide[1] = St.Side.BOTTOM;
                break;
        }
        switch (grabOp) {
            case Meta.GrabOp.RESIZING_E:
            case Meta.GrabOp.RESIZING_NE:
            case Meta.GrabOp.RESIZING_SE:
            case Meta.GrabOp.KEYBOARD_RESIZING_E:
            case Meta.GrabOp.KEYBOARD_RESIZING_NE:
            case Meta.GrabOp.KEYBOARD_RESIZING_SE:
                horizontalSide[0] = true;
                horizontalSide[1] = St.Side.RIGHT;
                break;
            case Meta.GrabOp.RESIZING_W:
            case Meta.GrabOp.RESIZING_NW:
            case Meta.GrabOp.RESIZING_SW:
            case Meta.GrabOp.KEYBOARD_RESIZING_W:
            case Meta.GrabOp.KEYBOARD_RESIZING_NW:
            case Meta.GrabOp.KEYBOARD_RESIZING_SW:
                horizontalSide[0] = true;
                horizontalSide[1] = St.Side.LEFT;
                break;
        }
        if (!verticalSide[0] && !horizontalSide[0]) return;

        const otherTiledWindows = getWindows().filter(
            (otherWindow) =>
                otherWindow &&
                (otherWindow as ExtendedWindow).assignedTile &&
                otherWindow !== window &&
                !otherWindow.minimized,
        );
        if (otherTiledWindows.length === 0) return;

        const verticalAdjacentWindows = verticalSide[0]
            ? this._findAdjacent(
                  window,
                  verticalSide[1],
                  new Set(otherTiledWindows),
              )
            : [];
        const horizontalAdjacentWindows = horizontalSide[0]
            ? this._findAdjacent(
                  window,
                  horizontalSide[1],
                  new Set(otherTiledWindows),
              )
            : [];

        const windowsMap: Map<
            Meta.Window,
            [Meta.Window, Mtk.Rectangle, number, number]
        > = new Map();

        verticalAdjacentWindows.forEach(([otherWin, sideOtherWin]) => {
            windowsMap.set(otherWin, [
                otherWin,
                otherWin.get_frame_rect().copy(),
                sideOtherWin, // resize vertically
                -1, // resize horizontally
            ]);
        });

        horizontalAdjacentWindows.forEach(([otherWin, sideOtherWin]) => {
            const val = windowsMap.get(otherWin);
            if (val) {
                val[3] = sideOtherWin;
            } else {
                windowsMap.set(otherWin, [
                    otherWin,
                    otherWin.get_frame_rect().copy(),
                    -1, // resize vertically
                    sideOtherWin, // resize horizontally
                ]);
            }
        });

        this._addWindowsOnSameLine(
            window,
            verticalSide,
            horizontalSide,
            otherTiledWindows,
            windowsMap,
        );

        const windowsToResize = Array.from(windowsMap.values());
        if (windowsToResize.length > 0) {
            this._jointResize = [
                [window, window.get_frame_rect().copy()],
                ...windowsToResize.map(
                    ([otherWin, otherWinRect]): [Meta.Window, Mtk.Rectangle] => [
                        otherWin,
                        otherWinRect,
                    ],
                ),
            ];
        }

        this._signals.connect(
            window,
            'size-changed',
            this._onResizingWindow.bind(
                this,
                window,
                window.get_frame_rect().copy(),
                verticalSide[1],
                horizontalSide[1],
                windowsToResize,
            ),
        );
    }

    /**
     * Add the tiled windows whose side lies on the same layout line as the
     * grabbed side, even if they are not adjacent to the grabbed window
     * (e.g. a window below the grabbed one, with its side on the same line).
     * They are resized together, so that the line is moved as a whole.
     */
    private _addWindowsOnSameLine(
        window: Meta.Window,
        verticalSide: [boolean, St.Side],
        horizontalSide: [boolean, St.Side],
        otherTiledWindows: Meta.Window[],
        windowsMap: Map<
            Meta.Window,
            [Meta.Window, Mtk.Rectangle, number, number]
        >,
    ) {
        const tile = (window as ExtendedWindow).assignedTile!;
        const monitorIndex = window.get_monitor();
        const candidates = otherTiledWindows.filter(
            (win) => win.get_monitor() === monitorIndex,
        );
        if (candidates.length === 0) return;

        const layout = GlobalState.get().getSelectedLayoutOfMonitor(
            monitorIndex,
            global.workspaceManager.get_active_workspace_index(),
        );
        const tiles = [
            ...layout.tiles,
            tile,
            ...candidates.map((win) => (win as ExtendedWindow).assignedTile!),
        ];

        const grabbedSides: ['x' | 'y', St.Side][] = [];
        if (horizontalSide[0]) grabbedSides.push(['x', horizontalSide[1]]);
        if (verticalSide[0]) grabbedSides.push(['y', verticalSide[1]]);
        grabbedSides.forEach(([axis, side]) => {
            const value =
                axis === 'x'
                    ? side === St.Side.LEFT
                        ? tile.x
                        : tile.x + tile.width
                    : side === St.Side.TOP
                      ? tile.y
                      : tile.y + tile.height;
            if (isOnWorkAreaEdge(value)) return;

            const line = this._extendBorderAlongLayout(
                {
                    axis,
                    oldValue: value,
                    newValue: value,
                    from: axis === 'x' ? tile.y : tile.x,
                    to: axis === 'x' ? tile.y + tile.height : tile.x + tile.width,
                },
                tiles,
                [],
            );
            candidates.forEach((otherWin) => {
                const otherTile = (otherWin as ExtendedWindow).assignedTile!;
                const [start, size, from, length] =
                    axis === 'x'
                        ? [otherTile.x, otherTile.width, otherTile.y, otherTile.height]
                        : [otherTile.y, otherTile.height, otherTile.x, otherTile.width];
                let otherSide: St.Side;
                if (Math.abs(start - value) < BORDER_TOLERANCE)
                    otherSide = axis === 'x' ? St.Side.LEFT : St.Side.TOP;
                else if (Math.abs(start + size - value) < BORDER_TOLERANCE)
                    otherSide = axis === 'x' ? St.Side.RIGHT : St.Side.BOTTOM;
                else return;
                if (!rangesOverlap([from, from + length], [line.from, line.to]))
                    return;

                const entry: [Meta.Window, Mtk.Rectangle, number, number] =
                    windowsMap.get(otherWin) ?? [
                        otherWin,
                        otherWin.get_frame_rect().copy(),
                        -1,
                        -1,
                    ];
                const sideIndex = axis === 'x' ? 3 : 2;
                if (entry[sideIndex] !== -1) return;
                entry[sideIndex] = otherSide;
                windowsMap.set(otherWin, entry);
            });
        });
    }

    private _oppositeSide(side: St.Side): St.Side {
        switch (side) {
            case St.Side.TOP:
                return St.Side.BOTTOM;
            case St.Side.BOTTOM:
                return St.Side.TOP;
            case St.Side.LEFT:
                return St.Side.RIGHT;
        }

        // case St.Side.RIGHT
        return St.Side.LEFT;
    }

    private _findAdjacent(
        window: Meta.Window,
        side: St.Side,
        remainingWindows: Set<Meta.Window>,
    ): [Meta.Window, St.Side][] {
        const result: [Meta.Window, St.Side][] = [];
        const adjacentWindows: Meta.Window[] = [];
        const windowRect = window.get_frame_rect();
        const borderRect = windowRect.copy();
        const innerGaps = Settings.get_inner_gaps();
        if (innerGaps.top === 0) innerGaps.top = 2;
        if (innerGaps.bottom === 0) innerGaps.bottom = 2;
        if (innerGaps.left === 0) innerGaps.left = 2;
        if (innerGaps.right === 0) innerGaps.right = 2;
        const errorFactor = innerGaps.right * 4;
        switch (side) {
            case St.Side.TOP:
                borderRect.height = innerGaps.top + errorFactor;
                borderRect.y -= innerGaps.top + errorFactor;
                break;
            case St.Side.BOTTOM:
                borderRect.y += borderRect.height;
                borderRect.height = innerGaps.bottom + errorFactor;
                break;
            case St.Side.LEFT:
                borderRect.width = innerGaps.left + errorFactor;
                borderRect.x -= innerGaps.left + errorFactor;
                break;
            case St.Side.RIGHT:
                borderRect.x += borderRect.width;
                borderRect.width = innerGaps.right + errorFactor;
                break;
        }

        /* let debugWidget = new St.Widget({ style: "border: solid 1px red; border-radius: 2px; background-color: rgba(255, 255, 255, 0.2);"});
        debugWidget.set_size(borderRect.width, borderRect.height);
        debugWidget.set_position(borderRect.x, borderRect.y);
        debugWidget.show();
        global.windowGroup.add_child(debugWidget);*/

        const oppositeSide = this._oppositeSide(side);
        const newRemainingWindows: Set<Meta.Window> = new Set();
        remainingWindows.forEach((otherWin) => {
            const otherWinRect = otherWin.get_frame_rect();

            let [hasIntersection, intersection] = otherWin
                .get_frame_rect()
                .intersect(borderRect);
            switch (side) {
                case St.Side.RIGHT:
                    hasIntersection &&= intersection.x <= otherWinRect.x;
                    break;
                case St.Side.LEFT:
                    hasIntersection &&=
                        intersection.x + intersection.width >=
                        otherWinRect.x + otherWinRect.width;
                    break;
                case St.Side.BOTTOM:
                    hasIntersection &&= intersection.y <= otherWinRect.y;
                    break;
                case St.Side.TOP:
                    hasIntersection &&=
                        intersection.y + intersection.height >=
                        otherWinRect.y + otherWinRect.height;
                    break;
            }

            if (hasIntersection) {
                result.push([otherWin, oppositeSide]);
                adjacentWindows.push(otherWin);
            } else {
                newRemainingWindows.add(otherWin);
            }
        });

        adjacentWindows.forEach((otherWin) => {
            this._findAdjacent(
                otherWin,
                oppositeSide,
                newRemainingWindows,
            ).forEach((recursionResult) => {
                result.push(recursionResult);
                newRemainingWindows.delete(recursionResult[0]);
            });
        });
        return result;
    }

    private _onWindowResizingEnd(window: Meta.Window) {
        if (this._signals) this._signals.disconnect(window);

        const jointResize = this._jointResize;
        this._jointResize = null;
        if (jointResize && jointResize[0][0] === window)
            this._moveLayoutBorders(jointResize);
    }

    /**
     * After tiled windows were resized together, move the borders of the
     * layout's tiles accordingly, so that windows tiled afterwards fit the
     * new borders instead of the original ones.
     */
    private _moveLayoutBorders(jointResize: [Meta.Window, Mtk.Rectangle][]) {
        const window = jointResize[0][0];
        const monitorIndex = window.get_monitor();
        // windows on all workspaces (e.g. on secondary monitors when
        // workspaces are only on the primary one) use the active workspace
        const workspaceOf = (win: Meta.Window) =>
            win.is_on_all_workspaces()
                ? global.workspaceManager.get_active_workspace()
                : win.get_workspace();
        const workspace = workspaceOf(window);
        if (!workspace) return;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        if (workArea.width <= 0 || workArea.height <= 0) return;

        const resizedWindows = jointResize.filter(
            ([win]) =>
                (win as ExtendedWindow).assignedTile &&
                win.get_monitor() === monitorIndex &&
                workspaceOf(win) === workspace,
        );
        if (resizedWindows.length < 2) return;

        // collect the borders moved by each window. Borders on the edges of
        // the work area are never moved
        const movedBordersByWindow: MovedBorder[][] = [];
        resizedWindows.forEach(([win, startRect]) => {
            const tile = (win as ExtendedWindow).assignedTile!;
            const rect = win.get_frame_rect();
            const dx = (rect.x - startRect.x) / workArea.width;
            const dy = (rect.y - startRect.y) / workArea.height;
            const dRight =
                (rect.x + rect.width - startRect.x - startRect.width) /
                workArea.width;
            const dBottom =
                (rect.y + rect.height - startRect.y - startRect.height) /
                workArea.height;
            const candidates: MovedBorder[] = [
                {
                    axis: 'x',
                    oldValue: tile.x,
                    newValue: tile.x + dx,
                    from: tile.y,
                    to: tile.y + tile.height,
                },
                {
                    axis: 'x',
                    oldValue: tile.x + tile.width,
                    newValue: tile.x + tile.width + dRight,
                    from: tile.y,
                    to: tile.y + tile.height,
                },
                {
                    axis: 'y',
                    oldValue: tile.y,
                    newValue: tile.y + dy,
                    from: tile.x,
                    to: tile.x + tile.width,
                },
                {
                    axis: 'y',
                    oldValue: tile.y + tile.height,
                    newValue: tile.y + tile.height + dBottom,
                    from: tile.x,
                    to: tile.x + tile.width,
                },
            ];
            movedBordersByWindow.push(
                candidates.filter(
                    (border) =>
                        border.oldValue !== border.newValue &&
                        !isOnWorkAreaEdge(border.oldValue),
                ),
            );
        });
        // keep only the borders shared by at least two windows. This
        // excludes the sides of the grabbed window without adjacent windows
        const movedBorders = movedBordersByWindow.flatMap((borders, index) =>
            borders.filter((border) =>
                movedBordersByWindow.some(
                    (otherBorders, otherIndex) =>
                        otherIndex !== index &&
                        otherBorders.some(
                            (other) =>
                                other.axis === border.axis &&
                                Math.abs(other.oldValue - border.oldValue) <
                                    BORDER_TOLERANCE,
                        ),
                ),
            ),
        );
        if (movedBorders.length === 0) return;

        const layout = GlobalState.get().getSelectedLayoutOfMonitor(
            monitorIndex,
            workspace.index(),
        );
        // tiled windows that were not resized keep their tiles, the border
        // must not be extended along them
        const resizedSet = new Set(resizedWindows.map(([win]) => win));
        const keptTiles = getWindows(workspace)
            .filter(
                (win) =>
                    (win as ExtendedWindow).assignedTile &&
                    !resizedSet.has(win) &&
                    win.get_monitor() === monitorIndex &&
                    workspaceOf(win) === workspace,
            )
            .map((win) => (win as ExtendedWindow).assignedTile!);
        // a border continues along the layout tiles on the same line
        const extendedBorders = movedBorders.map((border) =>
            this._extendBorderAlongLayout(border, layout.tiles, keptTiles),
        );
        const newTiles = layout.tiles.map((tile) =>
            this._moveTileBorders(tile, extendedBorders),
        );
        const newWindowTiles = resizedWindows.map(([win]) =>
            this._moveTileBorders(
                (win as ExtendedWindow).assignedTile!,
                extendedBorders,
            ),
        );
        // abort if any tile collapsed
        if (
            [...newTiles, ...newWindowTiles].some(
                (tile) => tile.width <= 0 || tile.height <= 0,
            )
        )
            return;

        resizedWindows.forEach(([win], index) => {
            (win as ExtendedWindow).assignedTile = newWindowTiles[index];
        });
        GlobalState.get().setAdjustedLayoutOfMonitor(
            new Layout(newTiles, layout.id),
            monitorIndex,
            workspace.index(),
        );
    }

    /**
     * Extend the border to the sides of the layout's tiles lying on the same
     * line and overlapping it, directly or through other sides. Sides that
     * only touch it at one point (e.g. crossing lines) are not included.
     * Sides overlapping a side of the kept tiles (tiles of windows that were
     * not resized) are not included either, so those windows keep fitting
     * their tiles.
     */
    private _extendBorderAlongLayout(
        border: MovedBorder,
        tiles: Tile[],
        keptTiles: Tile[],
    ): MovedBorder {
        const sidesOnBorder = (tiles: Tile[]) => {
            const result: [number, number][] = [];
            tiles.forEach((tile) => {
                const [start, size, from, length] =
                    border.axis === 'x'
                        ? [tile.x, tile.width, tile.y, tile.height]
                        : [tile.y, tile.height, tile.x, tile.width];
                if (
                    Math.abs(start - border.oldValue) < BORDER_TOLERANCE ||
                    Math.abs(start + size - border.oldValue) < BORDER_TOLERANCE
                )
                    result.push([from, from + length]);
            });
            return result;
        };
        const keptSides = sidesOnBorder(keptTiles);
        const sides = sidesOnBorder(tiles).filter(
            (side) => !keptSides.some((kept) => rangesOverlap(side, kept)),
        );

        let { from, to } = border;
        let extended = true;
        while (extended) {
            extended = false;
            for (const [sideFrom, sideTo] of sides) {
                if (
                    rangesOverlap([sideFrom, sideTo], [from, to]) &&
                    (sideFrom < from || sideTo > to)
                ) {
                    from = Math.min(from, sideFrom);
                    to = Math.max(to, sideTo);
                    extended = true;
                }
            }
        }
        return { ...border, from, to };
    }

    private _moveTileBorders(tile: Tile, movedBorders: MovedBorder[]): Tile {
        // move a border of the tile if it lies on a moved border and
        // they overlap along the other axis
        const moveBorder = (
            axis: 'x' | 'y',
            value: number,
            from: number,
            to: number,
        ): number => {
            const border = movedBorders.find(
                (b) =>
                    b.axis === axis &&
                    Math.abs(b.oldValue - value) < BORDER_TOLERANCE &&
                    Math.min(b.to, to) - Math.max(b.from, from) >
                        BORDER_TOLERANCE,
            );
            return border ? border.newValue : value;
        };

        const left = moveBorder('x', tile.x, tile.y, tile.y + tile.height);
        const right = moveBorder(
            'x',
            tile.x + tile.width,
            tile.y,
            tile.y + tile.height,
        );
        const top = moveBorder('y', tile.y, tile.x, tile.x + tile.width);
        const bottom = moveBorder(
            'y',
            tile.y + tile.height,
            tile.x,
            tile.x + tile.width,
        );
        return new Tile({
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
            groups: tile.groups,
        });
    }

    private _onResizingWindow(
        window: Meta.Window,
        startingRect: Mtk.Rectangle,
        resizeVerticalSide: number,
        resizeHorizontalSide: number,
        windowsToResize: [Meta.Window, Mtk.Rectangle, number, number][],
    ) {
        const currentRect = window.get_frame_rect();

        const resizedRect = {
            x: currentRect.x - startingRect.x,
            y: currentRect.y - startingRect.y,
            width: currentRect.width - startingRect.width,
            height: currentRect.height - startingRect.height,
        };

        windowsToResize.forEach(
            ([otherWindow, otherWindowRect, verticalSide, horizontalSide]) => {
                const isSameVerticalSide =
                    verticalSide !== -1 && verticalSide === resizeVerticalSide;
                const isSameHorizontalSide =
                    horizontalSide !== -1 &&
                    horizontalSide === resizeHorizontalSide;

                const rect = [
                    otherWindowRect.x,
                    otherWindowRect.y,
                    otherWindowRect.width,
                    otherWindowRect.height,
                ];
                if (horizontalSide === St.Side.LEFT) {
                    // update width and x
                    rect[2] =
                        otherWindowRect.width -
                        (isSameHorizontalSide
                            ? resizedRect.x
                            : resizedRect.width);
                    rect[0] =
                        otherWindowRect.x +
                        (isSameHorizontalSide
                            ? resizedRect.x
                            : resizedRect.width);
                } else if (horizontalSide === St.Side.RIGHT) {
                    // update width
                    rect[2] =
                        otherWindowRect.width +
                        (isSameHorizontalSide
                            ? resizedRect.width
                            : resizedRect.x);
                }

                if (verticalSide === St.Side.TOP) {
                    // update height and y
                    rect[3] =
                        otherWindowRect.height -
                        (isSameVerticalSide
                            ? resizedRect.y
                            : resizedRect.height);
                    rect[1] =
                        otherWindowRect.y +
                        (isSameVerticalSide
                            ? resizedRect.y
                            : resizedRect.height);
                } else if (verticalSide === St.Side.BOTTOM) {
                    // update height
                    rect[3] =
                        otherWindowRect.height +
                        (isSameVerticalSide
                            ? resizedRect.height
                            : resizedRect.y);
                }

                otherWindow.move_resize_frame(
                    false,
                    Math.max(0, rect[0]),
                    Math.max(0, rect[1]),
                    Math.max(0, rect[2]),
                    Math.max(0, rect[3]),
                );
            },
        );
    }
}

/*
const WINDOW_CLONE_RESIZE_ANIMATION_TIME = 150;
const APP_ICON_SIZE = 96;

class WindowClone extends St.Widget {
    static { registerGObjectClass(this) }

    private _clone: Clutter.Actor;
    //private _blurWidget: St.Widget;

    constructor(window: Meta.Window) {
        super({ layoutManager: new Clutter.BinLayout(), styleClass: "custom-tile-preview" });
        global.windowGroup.add_child(this);

        this._clone = this._createWindowClone(window);
        this.add_child(this._clone);
        const sigma = 36;
        this._clone.add_effect_with_name('blur', new Shell.BlurEffect({
            //@ts-ignore
            sigma: sigma,
            //radius: sigma * 2,
            brightness: 1,
            mode: Shell.BlurMode.ACTOR, // blur the widget
        }));

        const box = new St.BoxLayout({
            xAlign: Clutter.ActorAlign.CENTER,
            yAlign: Clutter.ActorAlign.CENTER,
            xExpand: true,
            yExpand: true,
            style: "spacing: 16px;"
        });
        setWidgetOrientation(box, true);
        box.add_child(this._createAppIcon(window, APP_ICON_SIZE));
        box.add_child(new St.Label({
            xAlign: Clutter.ActorAlign.CENTER,
            yAlign: Clutter.ActorAlign.CENTER,
            text: window.get_title(),
            style: "color: white;"
        }));
        this.add_child(box);

        const windowRect = window.get_frame_rect();
        this.set_position(windowRect.x, windowRect.y);
        this.set_size(windowRect.width, windowRect.height);

        //this.updateEffect();
    }

    private _createWindowClone(window: Meta.Window) {
        //@ts-ignore
        //const actor: Clutter.Actor = window.get_compositor_private();
        //return new Clutter.Clone({
        //    source: actor
        //});
        //@ts-ignore
        const actor: Clutter.Actor = window.get_compositor_private();

        //@ts-ignore
        let actorContent = actor.paint_to_content(window.get_frame_rect());
        let actorClone = new St.Widget({
            content: actorContent,
            width: window.get_frame_rect().width,
            height: window.get_frame_rect().height,
            xExpand: true,
            yExpand: true
        });
        actorClone.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        return actorClone;
    }

    private _createAppIcon(window: Meta.Window, size: number) {
        let tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(window);
        let appIcon = app
            ? app.create_icon_texture(size)
            : new St.Icon({ iconName: 'application-x-executable', iconSize: size });
        appIcon.xExpand = appIcon.yExpand = true;
        appIcon.xAlign = appIcon.yAlign = Clutter.ActorAlign.CENTER;

        return appIcon;
    }
}
*/
