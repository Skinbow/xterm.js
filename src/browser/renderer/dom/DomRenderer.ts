/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { BOLD_CLASS, CURSOR_BLINK_CLASS, CURSOR_CLASS, CURSOR_STYLE_BAR_CLASS, CURSOR_STYLE_BLOCK_CLASS, CURSOR_STYLE_UNDERLINE_CLASS, DIM_CLASS, DomRendererRowFactory, ITALIC_CLASS } from 'browser/renderer/dom/DomRendererRowFactory';
import { INVERTED_DEFAULT_COLOR } from 'browser/renderer/shared/Constants';
import { createRenderDimensions } from 'browser/renderer/shared/RendererUtils';
import { IRenderDimensions, IRenderer, IRequestRedrawEvent } from 'browser/renderer/shared/Types';
import { ICharSizeService, ICoreBrowserService, IThemeService } from 'browser/services/Services';
import { ILinkifier2, ILinkifierEvent, ReadonlyColorSet } from 'browser/Types';
import { color } from 'common/Color';
import { EventEmitter } from 'common/EventEmitter';
import { Disposable, toDisposable } from 'common/Lifecycle';
import { IBufferService, IInstantiationService, IOptionsService } from 'common/services/Services';
import { IdleTaskQueue } from 'common/TaskQueue';

const TERMINAL_CLASS_PREFIX = 'xterm-dom-renderer-owner-';
const ROW_CONTAINER_CLASS = 'xterm-rows';
const FG_CLASS_PREFIX = 'xterm-fg-';
const BG_CLASS_PREFIX = 'xterm-bg-';
const FOCUS_CLASS = 'xterm-focus';
const SELECTION_CLASS = 'xterm-selection';

let nextTerminalId = 1;

// font metrics calc settings
const enum FontMetrics {
  START = 32,         // start codepoint
  MAX = 256,          // only calc up to this codepoint (256 means only Basic Latin + Latin-1 Supplement)
  BATCH_SIZE = 30,    // amount of codepoints to calc in a single batch (sync & blocking)
  THRESHOLD = 0.005   // allowed relative deviation from cell width
}

/**
 * A fallback renderer for when canvas is slow. This is not meant to be
 * particularly fast or feature complete, more just stable and usable for when
 * canvas is not an option.
 */
export class DomRenderer extends Disposable implements IRenderer {
  private _rowFactory: DomRendererRowFactory;
  private _terminalClass: number = nextTerminalId++;

  private _themeStyleElement!: HTMLStyleElement;
  private _dimensionsStyleElement!: HTMLStyleElement;
  private _rowContainer: HTMLElement;
  private _rowElements: HTMLElement[] = [];
  private _selectionContainer: HTMLElement;
  private _linkState = new Uint8Array(3);
  private _fontMetrics: Uint8Array = new Uint8Array(FontMetrics.MAX);
  private _metricsQueue = new IdleTaskQueue();
  private _metricsPos: number = FontMetrics.START;

  public dimensions: IRenderDimensions;

  public readonly onRequestRedraw = this.register(new EventEmitter<IRequestRedrawEvent>()).event;

  constructor(
    private readonly _element: HTMLElement,
    private readonly _screenElement: HTMLElement,
    private readonly _viewportElement: HTMLElement,
    private readonly _linkifier2: ILinkifier2,
    @IInstantiationService instantiationService: IInstantiationService,
    @ICharSizeService private readonly _charSizeService: ICharSizeService,
    @IOptionsService private readonly _optionsService: IOptionsService,
    @IBufferService private readonly _bufferService: IBufferService,
    @ICoreBrowserService private readonly _coreBrowserService: ICoreBrowserService,
    @IThemeService private readonly _themeService: IThemeService
  ) {
    super();
    this._rowContainer = document.createElement('div');
    this._rowContainer.classList.add(ROW_CONTAINER_CLASS);
    this._rowContainer.style.lineHeight = 'normal';
    this._rowContainer.setAttribute('aria-hidden', 'true');
    this._refreshRowElements(this._bufferService.cols, this._bufferService.rows);
    this._selectionContainer = document.createElement('div');
    this._selectionContainer.classList.add(SELECTION_CLASS);
    this._selectionContainer.setAttribute('aria-hidden', 'true');

    this.dimensions = createRenderDimensions();
    this._updateDimensions();
    this.register(this._optionsService.onOptionChange(() => this._handleOptionsChanged()));

    this.register(this._themeService.onChangeColors(e => this._injectCss(e)));
    this._injectCss(this._themeService.colors);

    this._rowFactory = instantiationService.createInstance(DomRendererRowFactory, document);

    this._element.classList.add(TERMINAL_CLASS_PREFIX + this._terminalClass);
    this._screenElement.appendChild(this._rowContainer);
    this._screenElement.appendChild(this._selectionContainer);

    this.register(this._linkifier2.onShowLinkUnderline(e => this._handleLinkHover(e)));
    this.register(this._linkifier2.onHideLinkUnderline(e => this._handleLinkLeave(e)));

    this.register(toDisposable(() => {
      this._element.classList.remove(TERMINAL_CLASS_PREFIX + this._terminalClass);

      // Outside influences such as React unmounts may manipulate the DOM before our disposal.
      // https://github.com/xtermjs/xterm.js/issues/2960
      this._rowContainer.remove();
      this._selectionContainer.remove();
      this._themeStyleElement.remove();
      this._dimensionsStyleElement.remove();
    }));

    this._cacheMetrics();
  }

  private _batchedMetrics(): boolean {
    const parent = this._screenElement.querySelector('.xterm-helpers');
    if (!parent) {
      this._metricsPos = FontMetrics.START;
      return false;
    }

    const container = document.createElement('div');
    container.setAttribute('aria-hidden', 'true');
    container.style.whiteSpace = 'pre';
    container.style.overflow = 'hidden';
    container.style.fontFamily = this._optionsService.rawOptions.fontFamily;
    container.style.fontSize = `${this._optionsService.rawOptions.fontSize}px`;

    const cellWidth = this.dimensions.css.cell.width;
    const lower = 10 * cellWidth * (1 - FontMetrics.THRESHOLD);
    const upper = 10 * cellWidth * (1 + FontMetrics.THRESHOLD);
    const end = Math.min(this._metricsPos + FontMetrics.BATCH_SIZE, FontMetrics.MAX);

    for (let i = this._metricsPos; i < end; ++i) {
      const el = document.createElement('span');
      el.classList.add('xterm-char-measure-element');
      el.textContent = String.fromCharCode(i).repeat(10);
      container.appendChild(el);
    }
    parent.appendChild(container);

    const collection = container.children;
    for (let i = 0; i < collection.length; ++i) {
      const width = collection[i].getBoundingClientRect().width;
      this._fontMetrics[i + this._metricsPos] = +(width < lower || width > upper);
    }
    container.remove();

    this._metricsPos = end;
    if (this._metricsPos >= FontMetrics.MAX) {
      this._metricsPos = FontMetrics.START;
      return false;
    }
    return true;
  }

  private _cacheMetrics(): void {
    this._metricsQueue.clear();
    this._fontMetrics.fill(0xFF);
    this._metricsPos = FontMetrics.START;
    this._metricsQueue.enqueue(() => this._batchedMetrics());
  }

  private _updateDimensions(): void {
    const dpr = this._coreBrowserService.dpr;
    this.dimensions.device.char.width = this._charSizeService.width * dpr;
    this.dimensions.device.char.height = Math.ceil(this._charSizeService.height * dpr);
    this.dimensions.device.cell.width = this.dimensions.device.char.width + Math.round(this._optionsService.rawOptions.letterSpacing);
    this.dimensions.device.cell.height = Math.floor(this.dimensions.device.char.height * this._optionsService.rawOptions.lineHeight);
    this.dimensions.device.char.left = 0;
    this.dimensions.device.char.top = 0;
    this.dimensions.device.canvas.width = this.dimensions.device.cell.width * this._bufferService.cols;
    this.dimensions.device.canvas.height = this.dimensions.device.cell.height * this._bufferService.rows;
    this.dimensions.css.canvas.width = Math.round(this.dimensions.device.canvas.width / dpr);
    this.dimensions.css.canvas.height = Math.round(this.dimensions.device.canvas.height / dpr);
    this.dimensions.css.cell.width = this.dimensions.css.canvas.width / this._bufferService.cols;
    this.dimensions.css.cell.height = this.dimensions.css.canvas.height / this._bufferService.rows;

    for (const element of this._rowElements) {
      element.style.width = `${this.dimensions.css.canvas.width}px`;
      element.style.height = `${this.dimensions.css.cell.height}px`;
      element.style.lineHeight = `${this.dimensions.css.cell.height}px`;
      // Make sure rows don't overflow onto following row
      element.style.overflow = 'hidden';
    }

    if (!this._dimensionsStyleElement) {
      this._dimensionsStyleElement = document.createElement('style');
      this._screenElement.appendChild(this._dimensionsStyleElement);
    }

    const styles =
      `${this._terminalSelector} .${ROW_CONTAINER_CLASS} span {` +
      ` display: inline-block;` +
      ` height: 100%;` +
      ` vertical-align: top;` +
      ` width: ${this.dimensions.css.cell.width}px;` +
      ` white-space: pre` +
      `}`;

    this._dimensionsStyleElement.textContent = styles;

    this._selectionContainer.style.height = this._viewportElement.style.height;
    this._screenElement.style.width = `${this.dimensions.css.canvas.width}px`;
    this._screenElement.style.height = `${this.dimensions.css.canvas.height}px`;
  }

  private _injectCss(colors: ReadonlyColorSet): void {
    if (!this._themeStyleElement) {
      this._themeStyleElement = document.createElement('style');
      this._screenElement.appendChild(this._themeStyleElement);
    }

    // Base CSS
    let styles =
      `${this._terminalSelector} .${ROW_CONTAINER_CLASS} {` +
      ` color: ${colors.foreground.css};` +
      ` font-family: ${this._optionsService.rawOptions.fontFamily};` +
      ` font-size: ${this._optionsService.rawOptions.fontSize}px;` +
      `}`;
    styles +=
      `${this._terminalSelector} .${ROW_CONTAINER_CLASS} .xterm-dim {` +
      ` color: ${color.multiplyOpacity(colors.foreground, 0.5).css};` +
      `}`;
    // Text styles
    styles +=
      `${this._terminalSelector} span:not(.${BOLD_CLASS}) {` +
      ` font-weight: ${this._optionsService.rawOptions.fontWeight};` +
      `}` +
      `${this._terminalSelector} span.${BOLD_CLASS} {` +
      ` font-weight: ${this._optionsService.rawOptions.fontWeightBold};` +
      `}` +
      `${this._terminalSelector} span.${ITALIC_CLASS} {` +
      ` font-style: italic;` +
      `}`;
    // Blink animation
    styles +=
      `@keyframes blink_box_shadow` + `_` + this._terminalClass + ` {` +
      ` 50% {` +
      `  box-shadow: none;` +
      ` }` +
      `}`;
    styles +=
      `@keyframes blink_block` + `_` + this._terminalClass + ` {` +
      ` 0% {` +
      `  background-color: ${colors.cursor.css};` +
      `  color: ${colors.cursorAccent.css};` +
      ` }` +
      ` 50% {` +
      `  background-color: ${colors.cursorAccent.css};` +
      `  color: ${colors.cursor.css};` +
      ` }` +
      `}`;
    // Cursor
    styles +=
      `${this._terminalSelector} .${ROW_CONTAINER_CLASS}:not(.${FOCUS_CLASS}) .${CURSOR_CLASS}.${CURSOR_STYLE_BLOCK_CLASS} ,` +
      `${this._terminalSelector} .${ROW_CONTAINER_CLASS}:not(.${FOCUS_CLASS}) .${CURSOR_CLASS}.${CURSOR_STYLE_BAR_CLASS} ,` +
      `${this._terminalSelector} .${ROW_CONTAINER_CLASS}:not(.${FOCUS_CLASS}) .${CURSOR_CLASS}.${CURSOR_STYLE_UNDERLINE_CLASS} ` +
      `{` +
      ` outline: 1px solid ${colors.cursor.css};` +
      ` outline-offset: -1px;` +
      `}` +
      `${this._terminalSelector} .${ROW_CONTAINER_CLASS}.${FOCUS_CLASS} .${CURSOR_CLASS}.${CURSOR_BLINK_CLASS}:not(.${CURSOR_STYLE_BLOCK_CLASS}) {` +
      ` animation: blink_box_shadow` + `_` + this._terminalClass + ` 1s step-end infinite;` +
      `}` +
      `${this._terminalSelector} .${ROW_CONTAINER_CLASS}.${FOCUS_CLASS} .${CURSOR_CLASS}.${CURSOR_BLINK_CLASS}.${CURSOR_STYLE_BLOCK_CLASS} {` +
      ` animation: blink_block` + `_` + this._terminalClass + ` 1s step-end infinite;` +
      `}` +
      `${this._terminalSelector} .${ROW_CONTAINER_CLASS}.${FOCUS_CLASS} .${CURSOR_CLASS}.${CURSOR_STYLE_BLOCK_CLASS} {` +
      ` background-color: ${colors.cursor.css};` +
      ` color: ${colors.cursorAccent.css};` +
      `}` +
      `${this._terminalSelector} .${ROW_CONTAINER_CLASS} .${CURSOR_CLASS}.${CURSOR_STYLE_BAR_CLASS} {` +
      ` box-shadow: ${this._optionsService.rawOptions.cursorWidth}px 0 0 ${colors.cursor.css} inset;` +
      `}` +
      `${this._terminalSelector} .${ROW_CONTAINER_CLASS} .${CURSOR_CLASS}.${CURSOR_STYLE_UNDERLINE_CLASS} {` +
      ` box-shadow: 0 -1px 0 ${colors.cursor.css} inset;` +
      `}`;
    // Selection
    styles +=
      `${this._terminalSelector} .${SELECTION_CLASS} {` +
      ` position: absolute;` +
      ` top: 0;` +
      ` left: 0;` +
      ` z-index: 1;` +
      ` pointer-events: none;` +
      `}` +
      `${this._terminalSelector}.focus .${SELECTION_CLASS} div {` +
      ` position: absolute;` +
      ` background-color: ${colors.selectionBackgroundOpaque.css};` +
      `}` +
      `${this._terminalSelector} .${SELECTION_CLASS} div {` +
      ` position: absolute;` +
      ` background-color: ${colors.selectionInactiveBackgroundOpaque.css};` +
      `}`;
    // Colors
    for (const [i, c] of colors.ansi.entries()) {
      styles +=
        `${this._terminalSelector} .${FG_CLASS_PREFIX}${i} { color: ${c.css}; }` +
        `${this._terminalSelector} .${FG_CLASS_PREFIX}${i}.${DIM_CLASS} { color: ${color.multiplyOpacity(c, 0.5).css}; }` +
        `${this._terminalSelector} .${BG_CLASS_PREFIX}${i} { background-color: ${c.css}; }`;
    }
    styles +=
      `${this._terminalSelector} .${FG_CLASS_PREFIX}${INVERTED_DEFAULT_COLOR} { color: ${color.opaque(colors.background).css}; }` +
      `${this._terminalSelector} .${FG_CLASS_PREFIX}${INVERTED_DEFAULT_COLOR}.${DIM_CLASS} { color: ${color.multiplyOpacity(color.opaque(colors.background), 0.5).css}; }` +
      `${this._terminalSelector} .${BG_CLASS_PREFIX}${INVERTED_DEFAULT_COLOR} { background-color: ${colors.foreground.css}; }`;

    this._themeStyleElement.textContent = styles;
  }

  public handleDevicePixelRatioChange(): void {
    this._updateDimensions();
  }

  private _refreshRowElements(cols: number, rows: number): void {
    // Add missing elements
    for (let i = this._rowElements.length; i <= rows; i++) {
      const row = document.createElement('div');
      this._rowContainer.appendChild(row);
      this._rowElements.push(row);
    }
    // Remove excess elements
    while (this._rowElements.length > rows) {
      this._rowContainer.removeChild(this._rowElements.pop()!);
    }
  }

  public handleResize(cols: number, rows: number): void {
    this._refreshRowElements(cols, rows);
    this._updateDimensions();
  }

  public handleCharSizeChanged(): void {
    this._updateDimensions();
  }

  public handleBlur(): void {
    this._rowContainer.classList.remove(FOCUS_CLASS);
  }

  public handleFocus(): void {
    this._rowContainer.classList.add(FOCUS_CLASS);
  }

  public handleSelectionChanged(start: [number, number] | undefined, end: [number, number] | undefined, columnSelectMode: boolean): void {
    // Remove all selections
    this._selectionContainer.replaceChildren();
    this._rowFactory.handleSelectionChanged(start, end, columnSelectMode);
    this.renderRows(0, this._bufferService.rows - 1);

    // Selection does not exist
    if (!start || !end) {
      return;
    }

    // Translate from buffer position to viewport position
    const viewportStartRow = start[1] - this._bufferService.buffer.ydisp;
    const viewportEndRow = end[1] - this._bufferService.buffer.ydisp;
    const viewportCappedStartRow = Math.max(viewportStartRow, 0);
    const viewportCappedEndRow = Math.min(viewportEndRow, this._bufferService.rows - 1);

    // No need to draw the selection
    if (viewportCappedStartRow >= this._bufferService.rows || viewportCappedEndRow < 0) {
      return;
    }

    // Create the selections
    const documentFragment = document.createDocumentFragment();

    if (columnSelectMode) {
      const isXFlipped = start[0] > end[0];
      documentFragment.appendChild(
        this._createSelectionElement(viewportCappedStartRow, isXFlipped ? end[0] : start[0], isXFlipped ? start[0] : end[0], viewportCappedEndRow - viewportCappedStartRow + 1)
      );
    } else {
      // Draw first row
      const startCol = viewportStartRow === viewportCappedStartRow ? start[0] : 0;
      const endCol = viewportCappedStartRow === viewportEndRow ? end[0] : this._bufferService.cols;
      documentFragment.appendChild(this._createSelectionElement(viewportCappedStartRow, startCol, endCol));
      // Draw middle rows
      const middleRowsCount = viewportCappedEndRow - viewportCappedStartRow - 1;
      documentFragment.appendChild(this._createSelectionElement(viewportCappedStartRow + 1, 0, this._bufferService.cols, middleRowsCount));
      // Draw final row
      if (viewportCappedStartRow !== viewportCappedEndRow) {
        // Only draw viewportEndRow if it's not the same as viewporttartRow
        const endCol = viewportEndRow === viewportCappedEndRow ? end[0] : this._bufferService.cols;
        documentFragment.appendChild(this._createSelectionElement(viewportCappedEndRow, 0, endCol));
      }
    }
    this._selectionContainer.appendChild(documentFragment);
  }

  /**
   * Creates a selection element at the specified position.
   * @param row The row of the selection.
   * @param colStart The start column.
   * @param colEnd The end columns.
   */
  private _createSelectionElement(row: number, colStart: number, colEnd: number, rowCount: number = 1): HTMLElement {
    const element = document.createElement('div');
    element.style.height = `${rowCount * this.dimensions.css.cell.height}px`;
    element.style.top = `${row * this.dimensions.css.cell.height}px`;
    element.style.left = `${colStart * this.dimensions.css.cell.width}px`;
    element.style.width = `${this.dimensions.css.cell.width * (colEnd - colStart)}px`;
    return element;
  }

  public handleCursorMove(): void {
    // No-op, the cursor is drawn when rows are drawn
  }

  private _handleOptionsChanged(): void {
    // Force a refresh
    this._updateDimensions();
    // Refresh CSS
    this._injectCss(this._themeService.colors);
    this._cacheMetrics();
  }

  public clear(): void {
    for (const e of this._rowElements) {
      /**
       * NOTE: This used to be `e.innerText = '';` but that doesn't work when using `jsdom` and `@testing-library/react`
       *
       * references:
       * - https://github.com/testing-library/react-testing-library/issues/1146
       * - https://github.com/jsdom/jsdom/issues/1245
       */
      e.replaceChildren();
    }
  }

  public renderRows(start: number, end: number): void {
    const cursorAbsoluteY = this._bufferService.buffer.ybase + this._bufferService.buffer.y;
    const cursorX = Math.min(this._bufferService.buffer.x, this._bufferService.cols - 1);
    const cursorBlink = this._optionsService.rawOptions.cursorBlink;

    for (let y = start; y <= end; y++) {
      const rowElement = this._rowElements[y];
      const row = y + this._bufferService.buffer.ydisp;
      const lineData = this._bufferService.buffer.lines.get(row);
      const cursorStyle = this._optionsService.rawOptions.cursorStyle;
      rowElement.replaceChildren(
        this._rowFactory.createRow(
          lineData!,
          row,
          row === cursorAbsoluteY,
          cursorStyle,
          cursorX,
          cursorBlink,
          this.dimensions.css.cell.width,
          this._fontMetrics,
          this._linkState
        )
      );
    }
  }

  private get _terminalSelector(): string {
    return `.${TERMINAL_CLASS_PREFIX}${this._terminalClass}`;
  }

  private _handleLinkHover(e: ILinkifierEvent): void {
    this._setCellUnderline(e.x1, e.x2, e.y1, e.y2, e.cols, true);
  }

  private _handleLinkLeave(e: ILinkifierEvent): void {
    this._setCellUnderline(e.x1, e.x2, e.y1, e.y2, e.cols, false);
  }

  private _setCellUnderline(x: number, x2: number, y: number, y2: number, cols: number, enabled: boolean): void {
    // clip coords into viewport
    if (y < 0) x = 0;
    if (y2 < 0) x2 = 0;
    const maxY = this._bufferService.rows - 1;
    y = Math.max(Math.min(y, maxY), 0);
    y2 = Math.max(Math.min(y2, maxY), 0);

    const cursorAbsoluteY = this._bufferService.buffer.ybase + this._bufferService.buffer.y;
    const cursorX = Math.min(this._bufferService.buffer.x, this._bufferService.cols - 1);
    const cursorBlink = this._optionsService.rawOptions.cursorBlink;
    const cursorStyle = this._optionsService.rawOptions.cursorStyle;
    cols = Math.min(cols, this._bufferService.cols);

    // refresh rows within link range
    this._linkState[0] = +enabled;
    for (let i = y; i <= y2; ++i) {
      const rowElement = this._rowElements[i];
      if (!rowElement) {
        break;
      }
      if (enabled) {
        this._linkState[1] = i === y ? x : 0;
        this._linkState[2] = (i === y2 ? x2 : cols) - 1;
      }
      const row = i + this._bufferService.buffer.ydisp;
      const lineData = this._bufferService.buffer.lines.get(row);
      rowElement.replaceChildren(
        this._rowFactory.createRow(
          lineData!,
          row,
          row === cursorAbsoluteY,
          cursorStyle,
          cursorX,
          cursorBlink,
          this.dimensions.css.cell.width,
          this._fontMetrics,
          this._linkState
        )
      );
    }
    this._linkState[0] = 0;
  }
}
