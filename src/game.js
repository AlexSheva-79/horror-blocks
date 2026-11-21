/* Пасть Бездны — головоломка с падающими монстрами.
 * Весь код игры в одном файле. Phaser 3 подключён из vendor/phaser.min.js.
 */
(function () {
  'use strict';

  // ---------- Размеры ----------
  const W = 1080, H = 1920;           // основная раскладка (портрет 9:16)
  // На вытянутых телефонах делаем мир выше, чтобы не было чёрных полос.
  const VH = (function () {
    const r = (window.innerHeight || 1920) / (window.innerWidth || 1080);
    return Math.round(Math.min(2400, Math.max(H, W * r)));
  })();
  const OY = (VH - H) / 2;            // сдвиг окон меню, чтобы они были по центру
  const COLS = 10, ROWS = 20;         // поле 10×20
  const TOP = 150;                    // полоска сверху: очки, уровень, «далее», пауза
  // Клетка как можно крупнее: поле во всю ширину или во всю высоту под полоской
  const CELL = Math.floor(Math.min(W / COLS, (VH - TOP - 8) / ROWS));
  const FX = Math.round((W - COLS * CELL) / 2);   // левый край поля
  const FY = TOP + 4;                             // верхний край поля
  const FW = COLS * CELL, FH = ROWS * CELL;
  const TEX = 128;                    // размер клетки в картинке

  const FONT = '"Trebuchet MS", "Arial Black", Arial, sans-serif';
  const BONE = '#e8d5a8', BONE_N = 0xe8d5a8;
  const BLOOD = '#c8191e';

  // ---------- Монстры ----------
  // w,h — размер картинки в клетках, cells — клетки тела [x,y] в картинке.
  const PIECES = {
    I: { w: 1, h: 4, cells: [[0, 0], [0, 1], [0, 2], [0, 3]] },
    O: { w: 2, h: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
    T: { w: 3, h: 2, cells: [[0, 0], [1, 0], [2, 0], [1, 1]] },
    S: { w: 3, h: 2, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
    Z: { w: 3, h: 2, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
    J: { w: 2, h: 3, cells: [[1, 0], [1, 1], [1, 2], [0, 2]] },
    L: { w: 2, h: 3, cells: [[0, 0], [0, 1], [0, 2], [1, 2]] },
  };
  const TYPES = Object.keys(PIECES);

  // Клетки фигуры при повороте r (0..3, по часовой стрелке).
  // Возвращает [{x, y, frame}] относительно угла фигуры.
  function shapeCells(type, r) {
    const p = PIECES[type];
    const cx = (p.w - 1) / 2, cy = (p.h - 1) / 2;
    return p.cells.map(([x0, y0]) => {
      let x = x0, y = y0;
      for (let i = 0; i < r; i++) {
        const nx = cx - (y - cy);
        const ny = cy + (x - cx);
        x = nx; y = ny;
      }
      return { x: Math.floor(x + 1e-6), y: Math.floor(y + 1e-6), frame: y0 * p.w + x0 };
    });
  }

  // Скорость падения (мс на одну клетку) для уровня
  function fallInterval(level) {
    return Math.max(50, Math.round(800 * Math.pow(0.82, level - 1)));
  }
  const LINE_SCORES = [0, 100, 300, 500, 800];
  const LOCK_DELAY = 500, MAX_LOCK_RESETS = 15;
  const DAS = 170, ARR = 55, SOFT_INTERVAL = 35;

  // ---------- Настройки (хранятся в браузере) ----------
  const store = {
    get(key, def) {
      try { const v = localStorage.getItem('pb_' + key); return v === null ? def : JSON.parse(v); }
      catch (e) { return def; }
    },
    set(key, v) { try { localStorage.setItem('pb_' + key, JSON.stringify(v)); } catch (e) { /* ничего */ } },
  };

  // =====================================================================
  class Preload extends Phaser.Scene {
    constructor() { super('Preload'); }
    preload() {
      const bar = this.add.graphics();
      this.load.on('progress', (v) => {
        bar.clear();
        bar.fillStyle(0x3a0a0e, 1).fillRect(W / 2 - 300, H / 2 - 10, 600, 20);
        bar.fillStyle(0xc8191e, 1).fillRect(W / 2 - 300, H / 2 - 10, 600 * v, 20);
      });
      this.load.image('bg', 'assets/background.jpg');
      for (const t of TYPES) {
        this.load.spritesheet('m_' + t, 'assets/monsters/' + t + '.png', { frameWidth: TEX, frameHeight: TEX });
      }
      const sfx = ['rotate', 'move', 'land', 'line', 'four', 'level', 'gameover', 'button'];
      for (const s of sfx) this.load.audio(s, 'assets/sfx/' + s + '.mp3');
      this.load.audio('music', ['assets/music/music.ogg', 'assets/music/music.m4a']);
    }
    create() {
      const el = document.getElementById('loading');
      if (el) el.remove();
      this.scene.start('Main');
    }
  }

  // =====================================================================
  class Main extends Phaser.Scene {
    constructor() { super('Main'); }

    create() {
      this.musicOn = store.get('music', true);
      this.soundOn = store.get('sound', true);
      this.buttonsOn = store.get('buttons', true);
      this.best = store.get('best', 0);
      this.mode = 'menu';

      this.input.addPointer(3);
      this.drawBackground();
      this.drawField();
      this.drawPanels();
      this.setupGestures();   // сначала жесты, кнопки поверх них
      this.drawButtons();
      this.setupKeyboard();

      this.music = this.sound.add('music', { loop: true, volume: 0.45 });
      if (this.sound.locked) this.sound.once('unlocked', () => this.updateMusic());
      else this.updateMusic();

      this.game.events.on('hidden', () => { if (this.mode === 'play') this.pauseGame(); });

      this.resetBoard();
      this.showMenu();
    }

    // ---------- Звук ----------
    sfx(key, vol = 1) {
      if (!this.soundOn) return;
      this.sound.play(key, { volume: vol });
    }
    updateMusic() {
      const want = this.musicOn && this.mode !== 'over';
      if (want && !this.music.isPlaying) {
        if (this.music.isPaused) this.music.resume(); else this.music.play();
      } else if (!want && this.music.isPlaying) {
        this.music.pause();
      }
    }

    // ---------- Оформление ----------
    drawBackground() {
      const bg = this.add.image(W / 2, VH / 2, 'bg');
      const s = Math.max(W / bg.width, VH / bg.height);
      bg.setScale(s);
    }

    drawField() {
      const g = this.add.graphics();
      g.fillStyle(0x050102, 0.55).fillRect(FX, FY, FW, FH);
      g.lineStyle(2, 0xffffff, 0.04);
      for (let x = 1; x < COLS; x++) g.lineBetween(FX + x * CELL, FY, FX + x * CELL, FY + FH);
      for (let y = 1; y < ROWS; y++) g.lineBetween(FX, FY + y * CELL, FX + FW, FY + y * CELL);
      g.lineStyle(4, 0x7a1418, 0.8).strokeRect(FX - 2, FY - 2, FW + 4, FH + 4);

      // Всё, что внутри поля, обрезается по его краю
      this.fieldLayer = this.add.container(0, 0);
      const maskShape = this.make.graphics({ add: false });
      maskShape.fillStyle(0xffffff).fillRect(FX, FY, FW, FH);
      this.fieldLayer.setMask(maskShape.createGeometryMask());
      this.flash = this.add.graphics();
    }

    panel(x, y, w, h) {
      const g = this.add.graphics();
      g.fillStyle(0x0a0204, 0.72).fillRoundedRect(x, y, w, h, 22);
      g.lineStyle(3, 0x7a1418, 0.9).strokeRoundedRect(x, y, w, h, 22);
      return g;
    }

    drawPanels() {
      const g = this.add.graphics();
      g.fillStyle(0x0a0204, 0.8).fillRect(0, 0, W, TOP);
      g.lineStyle(3, 0x7a1418, 0.9).lineBetween(0, TOP, W, TOP);
      const label = (x, t) => this.add.text(x, 42, t, { fontFamily: FONT, fontSize: '28px', color: BONE, fontStyle: 'bold' }).setOrigin(0.5);
      const value = (x) => this.add.text(x, 100, '0', { fontFamily: FONT, fontSize: '52px', color: '#ffffff', fontStyle: 'bold', stroke: '#000', strokeThickness: 6 }).setOrigin(0.5);
      label(150, 'ОЧКИ'); this.scoreText = value(150);
      label(390, 'УРОВЕНЬ'); this.levelText = value(390);
      label(590, 'РЯДЫ'); this.linesText = value(590);
      label(790, 'ДАЛЕЕ');
      this.nextBox = { x: 790, y: 102, w: 150, h: 72 };
      this.nextLayer = this.add.container(0, 0);

      // Кнопка паузы
      const px = 990, py = TOP / 2;
      const pb = this.add.graphics();
      const drawPause = (down) => {
        pb.clear();
        pb.fillStyle(down ? 0x4a1015 : 0x1a0608, 0.85).fillCircle(px, py, 52);
        pb.lineStyle(5, BONE_N, 0.9).strokeCircle(px, py, 52);
        pb.fillStyle(BONE_N, 1).fillRoundedRect(px - 20, py - 22, 14, 44, 4).fillRoundedRect(px + 6, py - 22, 14, 44, 4);
      };
      drawPause(false);
      const hit = this.add.zone(px, py, 150, TOP).setInteractive();
      hit.on('pointerdown', () => { drawPause(true); });
      hit.on('pointerup', () => {
        drawPause(false);
        if (this.mode === 'play') { this.sfx('button', 0.8); this.pauseGame(); }
      });
      hit.on('pointerout', () => drawPause(false));
    }

    // ---------- Кнопки управления ----------
    drawButtons() {
      const y = VH - 130;  // полупрозрачные кнопки поверх нижней части поля
      const defs = [
        { x: 115, r: 88, icon: 'left', down: () => this.pressDir(-1), up: () => this.releaseDir(-1) },
        { x: 315, r: 88, icon: 'right', down: () => this.pressDir(1), up: () => this.releaseDir(1) },
        { x: 540, r: 82, icon: 'soft', down: () => { this.softDrop = true; }, up: () => { this.softDrop = false; } },
        { x: 760, r: 88, icon: 'hard', down: () => this.hardDrop() },
        { x: 960, r: 100, icon: 'rotate', down: () => this.rotate(1) },
      ];
      this.ctrlButtons = [];
      for (const d of defs) {
        const g = this.add.graphics();
        const draw = (pressed) => {
          g.clear();
          g.fillStyle(pressed ? 0x8a1a20 : 0x1a0608, pressed ? 0.35 : 0.07).fillCircle(d.x, y, d.r);
          g.lineStyle(4, BONE_N, pressed ? 0.5 : 0.16).strokeCircle(d.x, y, d.r);
          this.drawIcon(g, d.icon, d.x, y, d.r, pressed ? 0.6 : 0.2);
        };
        draw(false);
        const zone = this.add.zone(d.x, y, d.r * 2 + 20, d.r * 2 + 40).setInteractive();
        let held = false;
        zone.on('pointerdown', () => {
          held = true; draw(true);
          if (this.mode === 'play') d.down();
        });
        const release = () => {
          if (!held) return;
          held = false; draw(false);
          if (d.up) d.up();
        };
        zone.on('pointerup', release);
        zone.on('pointerout', release);
        this.ctrlButtons.push({ g, zone });
      }
      this.applyButtons();
    }

    // Показать или спрятать кнопки управления (настройка в меню)
    applyButtons() {
      for (const b of this.ctrlButtons) {
        b.g.setVisible(this.buttonsOn);
        if (this.buttonsOn) b.zone.setInteractive(); else b.zone.disableInteractive();
      }
    }

    drawIcon(g, icon, x, y, r, alpha = 1) {
      g.fillStyle(BONE_N, alpha);
      g.lineStyle(14, BONE_N, alpha);
      const s = r * 0.42;
      if (icon === 'left') g.fillTriangle(x - s, y, x + s * 0.7, y - s, x + s * 0.7, y + s);
      if (icon === 'right') g.fillTriangle(x + s, y, x - s * 0.7, y - s, x - s * 0.7, y + s);
      if (icon === 'soft') g.fillTriangle(x, y + s, x - s, y - s * 0.7, x + s, y - s * 0.7);
      if (icon === 'hard') {
        g.fillTriangle(x, y + s * 0.5, x - s, y - s * 1.0, x + s, y - s * 1.0);
        g.fillRect(x - s, y + s * 0.75, s * 2, s * 0.35);
      }
      if (icon === 'rotate') {
        g.beginPath();
        g.arc(x, y, s * 0.95, Phaser.Math.DegToRad(-60), Phaser.Math.DegToRad(200), false);
        g.strokePath();
        // наконечник стрелки
        const a = Phaser.Math.DegToRad(-60);
        const ax = x + Math.cos(a) * s * 0.95, ay = y + Math.sin(a) * s * 0.95;
        g.fillTriangle(ax + s * 0.45, ay + s * 0.05, ax - s * 0.35, ay - s * 0.4, ax - s * 0.2, ay + s * 0.5);
      }
    }

    // ---------- Жесты на поле ----------
    setupGestures() {
      const zone = this.add.zone(0, TOP, W, VH - TOP).setOrigin(0).setInteractive();
      zone.on('pointerdown', (p) => {
        if (this.mode !== 'play') return;
        this.gesture = { id: p.id, x0: p.x, y0: p.y, t0: p.downTime, movedX: 0, movedY: 0, maxDist: 0, lastY: p.y, lastT: p.downTime, vy: 0 };
      });
      this.input.on('pointermove', (p) => {
        const gs = this.gesture;
        if (!gs || gs.id !== p.id || this.mode !== 'play') return;
        const dx = p.x - gs.x0, dy = p.y - gs.y0;
        gs.maxDist = Math.max(gs.maxDist, Math.hypot(dx, dy));
        const step = CELL * 0.85;
        const wantX = Math.trunc(dx / step);
        while (gs.movedX < wantX) { this.move(1); gs.movedX++; }
        while (gs.movedX > wantX) { this.move(-1); gs.movedX--; }
        const wantY = Math.max(0, Math.trunc((dy - CELL * 0.5) / CELL));
        if (Math.abs(dy) > Math.abs(dx) * 1.2) {
          while (gs.movedY < wantY) { this.softStep(); gs.movedY++; }
        }
        const dt = Math.max(1, p.moveTime - gs.lastT);
        gs.vy = (p.y - gs.lastY) / dt;
        gs.lastY = p.y; gs.lastT = p.moveTime;
      });
      this.input.on('pointerup', (p) => {
        const gs = this.gesture;
        if (!gs || gs.id !== p.id) return;
        this.gesture = null;
        if (this.mode !== 'play') return;
        const dt = p.upTime - gs.t0;
        const dy = p.y - gs.y0, dx = p.x - gs.x0;
        if (gs.maxDist < 24 && dt < 350) { this.rotate(1); return; }
        if (dy > 140 && gs.vy > 1.2 && Math.abs(dy) > Math.abs(dx) * 1.5) this.hardDrop();
      });
    }

    setupKeyboard() {
      const kb = this.input.keyboard;
      if (!kb) return;
      kb.on('keydown', (e) => {
        if (this.mode === 'menu' && (e.code === 'Enter' || e.code === 'Space')) { this.startGame(); return; }
        if (this.mode === 'over' && (e.code === 'Enter')) { this.startGame(); return; }
        if (e.code === 'KeyP' || e.code === 'Escape') {
          if (this.mode === 'play') this.pauseGame(); else if (this.mode === 'pause') this.resumeGame();
          return;
        }
        if (this.mode !== 'play' || e.repeat) return;
        switch (e.code) {
          case 'ArrowLeft': this.pressDir(-1); break;
          case 'ArrowRight': this.pressDir(1); break;
          case 'ArrowDown': this.softDrop = true; break;
          case 'ArrowUp': case 'KeyX': this.rotate(1); break;
          case 'KeyZ': this.rotate(-1); break;
          case 'Space': this.hardDrop(); break;
        }
      });
      kb.on('keyup', (e) => {
        if (e.code === 'ArrowLeft') this.releaseDir(-1);
        if (e.code === 'ArrowRight') this.releaseDir(1);
        if (e.code === 'ArrowDown') this.softDrop = false;
      });
    }

    // ---------- Состояние поля ----------
    resetBoard() {
      if (this.grid) for (const row of this.grid) for (const s of row) if (s) s.destroy();
      this.grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
      if (this.active) { this.active.sprites.forEach((s) => s.destroy()); this.active.ghost.forEach((s) => s.destroy()); }
      this.active = null;
      this.bag = [];
      this.queue = [];
      this.score = 0; this.lines = 0; this.level = 1;
      this.heldDir = 0; this.dasTimer = 0; this.softDrop = false;
      this.fallAcc = 0; this.lockTimer = 0; this.lockResets = 0;
      this.updateHud();
    }

    nextFromBag() {
      if (this.bag.length === 0) this.bag = Phaser.Utils.Array.Shuffle(TYPES.slice());
      return this.bag.pop();
    }

    cellSprite(type, frame, angle) {
      const s = this.add.image(0, 0, 'm_' + type, frame);
      s.setScale(CELL / TEX).setAngle(angle);
      this.fieldLayer.add(s);
      return s;
    }

    cellX(x) { return FX + x * CELL + CELL / 2; }
    cellY(y) { return FY + y * CELL + CELL / 2; }

    spawn() {
      while (this.queue.length < 2) this.queue.push(this.nextFromBag());
      const type = this.queue.shift();
      this.queue.push(this.nextFromBag());
      const r = 0;
      const cells = shapeCells(type, r);
      const minX = Math.min(...cells.map((c) => c.x)), maxX = Math.max(...cells.map((c) => c.x));
      const minY = Math.min(...cells.map((c) => c.y));
      const px = Math.floor((COLS - (maxX - minX + 1)) / 2) - minX;
      const py = -minY;
      const a = {
        type, r, x: px, y: py,
        sprites: cells.map((c) => this.cellSprite(type, c.frame, 0)),
        ghost: cells.map((c) => this.cellSprite(type, c.frame, 0).setAlpha(0.22)),
      };
      // призрак — под фигурой
      a.ghost.forEach((g) => this.fieldLayer.sendToBack(g));
      this.active = a;
      this.fallAcc = 0; this.lockTimer = 0; this.lockResets = 0;
      this.drawNext();
      if (!this.fits(type, r, px, py)) {
        this.renderActive();
        this.gameOver();
        return;
      }
      this.renderActive();
    }

    fits(type, r, px, py) {
      for (const c of shapeCells(type, r)) {
        const x = px + c.x, y = py + c.y;
        if (x < 0 || x >= COLS || y >= ROWS) return false;
        if (y >= 0 && this.grid[y][x]) return false;
      }
      return true;
    }

    ghostY() {
      const a = this.active;
      let y = a.y;
      while (this.fits(a.type, a.r, a.x, y + 1)) y++;
      return y;
    }

    renderActive() {
      const a = this.active;
      if (!a) return;
      const cells = shapeCells(a.type, a.r);
      const gy = this.ghostY();
      cells.forEach((c, i) => {
        a.sprites[i].setPosition(this.cellX(a.x + c.x), this.cellY(a.y + c.y)).setAngle(a.r * 90);
        a.ghost[i].setPosition(this.cellX(a.x + c.x), this.cellY(gy + c.y)).setAngle(a.r * 90);
      });
    }

    grounded() {
      const a = this.active;
      return !this.fits(a.type, a.r, a.x, a.y + 1);
    }

    afterShift() {
      if (this.grounded() && this.lockResets < MAX_LOCK_RESETS) { this.lockTimer = 0; this.lockResets++; }
      this.renderActive();
    }

    move(dir) {
      const a = this.active;
      if (!a || this.mode !== 'play') return false;
      if (this.fits(a.type, a.r, a.x + dir, a.y)) {
        a.x += dir;
        this.sfx('move', 0.5);
        this.afterShift();
        return true;
      }
      return false;
    }

    rotate(dir) {
      const a = this.active;
      if (!a || this.mode !== 'play') return;
      const nr = (a.r + (dir > 0 ? 1 : 3)) % 4;
      const kicks = [[0, 0], [-1, 0], [1, 0], [0, -1], [-2, 0], [2, 0], [-1, -1], [1, -1], [0, -2]];
      for (const [kx, ky] of kicks) {
        if (this.fits(a.type, nr, a.x + kx, a.y + ky)) {
          a.r = nr; a.x += kx; a.y += ky;
          this.sfx('rotate', 0.6);
          this.afterShift();
          return;
        }
      }
    }

    softStep() {
      const a = this.active;
      if (!a || this.mode !== 'play') return;
      if (this.fits(a.type, a.r, a.x, a.y + 1)) {
        a.y++; this.score += 1; this.fallAcc = 0;
        this.updateHud(); this.renderActive();
      }
    }

    hardDrop() {
      const a = this.active;
      if (!a || this.mode !== 'play') return;
      const gy = this.ghostY();
      this.score += 2 * (gy - a.y);
      a.y = gy;
      this.renderActive();
      this.lock();
    }

    pressDir(dir) {
      this.heldDir = dir; this.dasTimer = 0;
      this.move(dir);
    }
    releaseDir(dir) {
      if (this.heldDir === dir) this.heldDir = 0;
    }

    lock() {
      const a = this.active;
      const cells = shapeCells(a.type, a.r);
      let above = false;
      cells.forEach((c, i) => {
        const x = a.x + c.x, y = a.y + c.y;
        const s = a.sprites[i];
        if (y < 0) { above = true; s.destroy(); return; }
        this.grid[y][x] = s;
        // лёгкий «шмяк» при приземлении
        this.tweens.add({ targets: s, scaleY: (CELL / TEX) * 0.86, scaleX: (CELL / TEX) * 1.06, duration: 70, yoyo: true });
      });
      a.ghost.forEach((g) => g.destroy());
      this.active = null;
      this.sfx('land', 0.8);
      if (above) { this.gameOver(); return; }

      const full = [];
      for (let y = 0; y < ROWS; y++) if (this.grid[y].every((s) => s)) full.push(y);
      if (full.length) this.clearRows(full);
      else this.spawn();
    }

    clearRows(rows) {
      this.mode = 'clearing';
      const n = rows.length;
      this.sfx(n >= 4 ? 'four' : 'line', n >= 4 ? 0.7 : 0.9);
      if (n >= 4) this.cameras.main.shake(320, 0.012);

      // вспышка рядов
      this.flash.clear();
      this.flash.fillStyle(0xff2a2a, 0.35);
      for (const y of rows) this.flash.fillRect(FX, FY + y * CELL, FW, CELL);
      this.tweens.add({ targets: this.flash, alpha: { from: 1, to: 0 }, duration: 260 });

      for (const y of rows) {
        for (let x = 0; x < COLS; x++) {
          const s = this.grid[y][x];
          this.grid[y][x] = null;
          this.tweens.add({
            targets: s, scale: 0, alpha: 0, angle: s.angle + Phaser.Math.Between(-40, 40),
            duration: 240, delay: x * 12, ease: 'Back.easeIn', onComplete: () => s.destroy(),
          });
        }
      }

      this.time.delayedCall(240 + COLS * 12, () => {
        // сдвигаем всё, что выше, вниз
        const keep = [];
        for (let y = 0; y < ROWS; y++) if (!rows.includes(y)) keep.push(this.grid[y]);
        const empty = Array.from({ length: n }, () => Array(COLS).fill(null));
        this.grid = empty.concat(keep);
        for (let y = 0; y < ROWS; y++) {
          for (let x = 0; x < COLS; x++) {
            const s = this.grid[y][x];
            if (s && s.y !== this.cellY(y)) this.tweens.add({ targets: s, y: this.cellY(y), duration: 110, ease: 'Quad.easeIn' });
          }
        }
        // очки и уровень
        const oldLevel = this.level;
        this.score += LINE_SCORES[Math.min(n, 4)] * this.level;
        this.lines += n;
        this.level = Math.floor(this.lines / 10) + 1;
        this.updateHud();
        if (n >= 4) this.popText('ЧЕТЫРЕ!', '#ff3b3b');
        if (this.level > oldLevel) {
          this.time.delayedCall(n >= 4 ? 700 : 150, () => {
            this.sfx('level', 0.8);
            this.popText('УРОВЕНЬ ' + this.level, '#ffd34d');
          });
        }
        this.time.delayedCall(120, () => {
          if (this.mode === 'clearing') { this.mode = 'play'; this.spawn(); }
        });
      });
    }

    popText(text, color) {
      const t = this.add.text(W / 2, FY + FH * 0.4, text, {
        fontFamily: FONT, fontSize: '96px', color, fontStyle: 'bold', stroke: '#000000', strokeThickness: 14,
      }).setOrigin(0.5).setScale(0.3).setDepth(50);
      this.tweens.add({ targets: t, scale: 1, duration: 260, ease: 'Back.easeOut' });
      this.tweens.add({ targets: t, alpha: 0, y: t.y - 120, delay: 900, duration: 500, onComplete: () => t.destroy() });
    }

    drawNext() {
      this.nextLayer.removeAll(true);
      const type = this.queue[0];
      const p = PIECES[type];
      const r = p.h > p.w ? 1 : 0;   // высоких монстров кладём на бок, чтобы влезли в полоску
      const cells = shapeCells(type, r);
      const minX = Math.min(...cells.map((q) => q.x)), maxX = Math.max(...cells.map((q) => q.x));
      const minY = Math.min(...cells.map((q) => q.y)), maxY = Math.max(...cells.map((q) => q.y));
      const cw = maxX - minX + 1, ch = maxY - minY + 1;
      const b = this.nextBox;
      const size = Math.min(b.w / cw, b.h / ch, 40);
      const ox = b.x - (cw * size) / 2, oy = b.y - (ch * size) / 2;
      for (const q of cells) {
        const s = this.add.image(ox + (q.x - minX) * size + size / 2, oy + (q.y - minY) * size + size / 2, 'm_' + type, q.frame);
        this.nextLayer.add(s.setScale(size / TEX).setAngle(r * 90));
      }
    }

    updateHud() {
      this.scoreText.setText(String(this.score));
      this.levelText.setText(String(this.level));
      this.linesText.setText(String(this.lines));
    }

    // ---------- Главный цикл ----------
    update(time, delta) {
      if (this.mode !== 'play' || !this.active) return;

      // удержание кнопки влево/вправо
      if (this.heldDir) {
        this.dasTimer += delta;
        if (this.dasTimer >= DAS) {
          while (this.dasTimer >= DAS + ARR) { this.dasTimer -= ARR; this.move(this.heldDir); if (!this.active) return; }
        }
      }

      const interval = this.softDrop ? Math.min(SOFT_INTERVAL, fallInterval(this.level)) : fallInterval(this.level);
      if (this.grounded()) {
        this.fallAcc = 0;
        this.lockTimer += delta;
        if (this.lockTimer >= LOCK_DELAY || this.lockResets >= MAX_LOCK_RESETS && this.lockTimer >= 100) this.lock();
        return;
      }
      this.lockTimer = 0;
      this.fallAcc += delta;
      while (this.fallAcc >= interval && this.active) {
        this.fallAcc -= interval;
        const a = this.active;
        if (this.fits(a.type, a.r, a.x, a.y + 1)) {
          a.y++;
          if (this.softDrop) this.score += 1;
        } else break;
      }
      if (this.softDrop) this.updateHud();
      this.renderActive();
    }

    // ---------- Меню и окна ----------
    makeButton(parent, x, y, w, h, label, onClick, opts = {}) {
      const g = this.add.graphics();
      const fill = opts.fill || 0x8a1218;
      const draw = (down) => {
        g.clear();
        g.fillStyle(down ? 0x3a070a : fill, 1).fillRoundedRect(x - w / 2, y - h / 2, w, h, 28);
        g.lineStyle(5, BONE_N, 1).strokeRoundedRect(x - w / 2, y - h / 2, w, h, 28);
      };
      draw(false);
      const t = this.add.text(x, y, label, { fontFamily: FONT, fontSize: (opts.size || 56) + 'px', color: BONE, fontStyle: 'bold', stroke: '#000', strokeThickness: 6 }).setOrigin(0.5);
      const z = this.add.zone(x, y, w, h).setInteractive({ useHandCursor: true });
      z.on('pointerdown', () => draw(true));
      z.on('pointerout', () => draw(false));
      z.on('pointerup', () => { draw(false); this.sfx('button', 0.8); onClick(t); });
      parent.add([g, t, z]);
      return t;
    }

    overlay() {
      const c = this.add.container(0, OY).setDepth(100);
      const dim = this.add.rectangle(W / 2, H / 2, W, VH, 0x050102, 0.78).setInteractive(); // блокирует нажатия под окном
      c.add(dim);
      return c;
    }

    toggles(c, y) {
      const label = (on, name) => name + ': ' + (on ? 'вкл' : 'выкл');
      this.makeButton(c, W / 2 - 215, y, 400, 110, label(this.musicOn, 'Музыка'), (t) => {
        this.musicOn = !this.musicOn; store.set('music', this.musicOn);
        t.setText(label(this.musicOn, 'Музыка')); this.updateMusic();
      }, { size: 42, fill: 0x2a080b });
      this.makeButton(c, W / 2 + 215, y, 400, 110, label(this.soundOn, 'Звуки'), (t) => {
        this.soundOn = !this.soundOn; store.set('sound', this.soundOn);
        t.setText(label(this.soundOn, 'Звуки'));
      }, { size: 42, fill: 0x2a080b });
      this.makeButton(c, W / 2, y + 130, 400, 110, label(this.buttonsOn, 'Кнопки'), (t) => {
        this.buttonsOn = !this.buttonsOn; store.set('buttons', this.buttonsOn);
        t.setText(label(this.buttonsOn, 'Кнопки')); this.applyButtons();
      }, { size: 42, fill: 0x2a080b });
    }

    closeOverlay() { if (this.ui) { this.ui.destroy(); this.ui = null; } }

    showMenu() {
      this.closeOverlay();
      this.mode = 'menu';
      const c = this.ui = this.overlay();
      const title = this.add.text(W / 2, 420, 'ПАСТЬ\nБЕЗДНЫ', {
        fontFamily: FONT, fontSize: '170px', color: BLOOD, fontStyle: 'bold', align: 'center',
        stroke: '#000000', strokeThickness: 18, lineSpacing: -20,
        shadow: { offsetX: 0, offsetY: 10, color: '#000', blur: 20, fill: true },
      }).setOrigin(0.5);
      c.add(title);
      this.tweens.add({ targets: title, scaleX: 1.03, scaleY: 0.97, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

      // монстры для красоты
      const show = [['T', 0], ['I', 1], ['O', 0], ['L', 0], ['S', 0]];
      const sz = 52, gap = 28, row = this.add.container(0, 0);
      let x = 0;
      for (const [type, rot] of show) {
        const cells = shapeCells(type, rot);
        const minX = Math.min(...cells.map((q) => q.x)), maxX = Math.max(...cells.map((q) => q.x));
        const minY = Math.min(...cells.map((q) => q.y)), maxY = Math.max(...cells.map((q) => q.y));
        const bh = (maxY - minY + 1) * sz;
        for (const q of cells) {
          const s = this.add.image(x + (q.x - minX) * sz + sz / 2, (q.y - minY) * sz + sz / 2 - bh / 2, 'm_' + type, q.frame);
          row.add(s.setScale(sz / TEX).setAngle(rot * 90));
        }
        x += (maxX - minX + 1) * sz + gap;
      }
      row.setPosition((W - (x - gap)) / 2, 760);
      c.add(row);

      c.add(this.add.text(W / 2, 900, 'Собирай монстров в ряды —\nпасть их проглотит', {
        fontFamily: FONT, fontSize: '42px', color: BONE, align: 'center',
      }).setOrigin(0.5));

      this.makeButton(c, W / 2, 1110, 560, 160, 'ИГРАТЬ', () => this.startGame(), { size: 76 });
      this.toggles(c, 1300);
      c.add(this.add.text(W / 2, 1570, 'Рекорд: ' + this.best, { fontFamily: FONT, fontSize: '46px', color: '#ffd34d', fontStyle: 'bold', stroke: '#000', strokeThickness: 6 }).setOrigin(0.5));
      c.add(this.add.text(W / 2, 1690,
        'Управление: кнопки внизу (их можно выключить).\nТап по полю — поворот, свайп в сторону — сдвиг,\nрезкий свайп вниз — бросок.', {
          fontFamily: FONT, fontSize: '32px', color: '#bfa98a', align: 'center', lineSpacing: 6,
        }).setOrigin(0.5));
      c.add(this.add.text(W / 2, 1870, 'Музыка: «Carnival Grin», alanajordan (Pixabay)', {
        fontFamily: FONT, fontSize: '24px', color: '#7d6a55',
      }).setOrigin(0.5));
    }

    startGame() {
      this.closeOverlay();
      if (this.sys.game.device.input.touch && !this.scale.isFullscreen) {
        try { this.scale.startFullscreen(); } catch (e) { /* не страшно */ }
      }
      this.resetBoard();
      this.mode = 'play';
      this.updateMusic();
      this.spawn();
    }

    pauseGame() {
      if (this.mode !== 'play') return;
      this.mode = 'pause';
      this.heldDir = 0; this.softDrop = false;
      const c = this.ui = this.overlay();
      c.add(this.add.text(W / 2, 560, 'ПАУЗА', { fontFamily: FONT, fontSize: '130px', color: BLOOD, fontStyle: 'bold', stroke: '#000', strokeThickness: 16 }).setOrigin(0.5));
      this.makeButton(c, W / 2, 820, 600, 150, 'ПРОДОЛЖИТЬ', () => this.resumeGame(), { size: 64 });
      this.makeButton(c, W / 2, 1010, 600, 130, 'ЗАНОВО', () => this.startGame(), { size: 54, fill: 0x2a080b });
      this.makeButton(c, W / 2, 1180, 600, 130, 'МЕНЮ', () => { this.resetBoard(); this.showMenu(); }, { size: 54, fill: 0x2a080b });
      this.toggles(c, 1380);
    }

    resumeGame() {
      if (this.mode !== 'pause') return;
      this.closeOverlay();
      this.mode = 'play';
    }

    gameOver() {
      this.mode = 'over';
      this.heldDir = 0; this.softDrop = false;
      this.music.stop();
      this.sfx('gameover', 0.9);
      this.cameras.main.shake(400, 0.01);
      for (const row of this.grid) for (const s of row) if (s) s.setTint(0x555555);
      if (this.active) this.active.sprites.forEach((s) => s.setTint(0x555555));
      const record = this.score > this.best;
      if (record) { this.best = this.score; store.set('best', this.best); }

      this.time.delayedCall(700, () => {
        const c = this.ui = this.overlay();
        c.add(this.add.text(W / 2, 520, 'ПРОГЛОЧЕН!', { fontFamily: FONT, fontSize: '120px', color: BLOOD, fontStyle: 'bold', stroke: '#000', strokeThickness: 16 }).setOrigin(0.5));
        c.add(this.add.text(W / 2, 720, 'Очки: ' + this.score, { fontFamily: FONT, fontSize: '72px', color: '#ffffff', fontStyle: 'bold', stroke: '#000', strokeThickness: 8 }).setOrigin(0.5));
        c.add(this.add.text(W / 2, 820, record ? 'НОВЫЙ РЕКОРД!' : 'Рекорд: ' + this.best, { fontFamily: FONT, fontSize: '52px', color: '#ffd34d', fontStyle: 'bold', stroke: '#000', strokeThickness: 6 }).setOrigin(0.5));
        c.add(this.add.text(W / 2, 900, 'Уровень ' + this.level + ' · рядов ' + this.lines, { fontFamily: FONT, fontSize: '40px', color: BONE }).setOrigin(0.5));
        this.makeButton(c, W / 2, 1100, 600, 160, 'ЕЩЁ РАЗ', () => this.startGame(), { size: 70 });
        this.makeButton(c, W / 2, 1290, 600, 130, 'МЕНЮ', () => { this.resetBoard(); this.showMenu(); this.updateMusic(); }, { size: 54, fill: 0x2a080b });
      });
    }
  }

  // =====================================================================
  window.game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: W,
    height: VH,
    backgroundColor: '#0b0204',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    input: { activePointers: 4 },
    render: { antialias: true },
    scene: [Preload, Main],
  });
})();
