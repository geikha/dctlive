export default class DisplayController {
  constructor(canvas) {
    this.canvas = canvas;
    this._shown = false;
    this._flipY = false;
  }

  show() {
    this._shown = true;
    this.canvas.style.display = '';
  }

  hide() {
    this._shown = false;
    this.canvas.style.display = 'none';
  }

  mount(parent = document.body) {
    if (!parent || !(parent instanceof HTMLElement)) {
      throw new Error('DisplayController.mount: parent must be an HTMLElement');
    }
    if (this.canvas.parentNode !== parent) {
      parent.appendChild(this.canvas);
      this.canvas.style.position = 'absolute';
      this.canvas.style.top = '0';
      this.canvas.style.left = '0';
    }
  }

  unmount() {
    if (this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }

  setSize(width, height) {
    if (width !== undefined && width !== null) {
      this.canvas.style.width = typeof width === 'number' ? `${width}px` : width;
    }
    if (height !== undefined && height !== null) {
      this.canvas.style.height = typeof height === 'number' ? `${height}px` : height;
    }
  }

  set flipY(val) {
    this._flipY = !!val;
    this.canvas.style.transform = this._flipY ? 'scaleY(-1)' : '';
  }

  get flipY() {
    return this._flipY;
  }
}
