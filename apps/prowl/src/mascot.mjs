// Hoot, the reviewing owl. render() returns `height` rows of [style, text] segments for the scene strip.

const C = {
  body: '\x1b[38;5;180m', eye: '\x1b[1;38;5;220m', beak: '\x1b[38;5;208m',
  grass: '\x1b[38;5;71m', dirt: '\x1b[38;5;95m', bubble: '\x1b[38;5;250m', z: '\x1b[38;5;111m', alert: '\x1b[1;38;5;203m',
};
const CONFETTI = ['\x1b[38;5;220m', '\x1b[38;5;203m', '\x1b[38;5;114m', '\x1b[38;5;75m', '\x1b[38;5;176m'];
const GROUND = "_,_._'__._,_.__'_,__._";

const SPRITES = {
  idle: ['  ,_,  ', ' (o,o) ', ' (   ) ', ' -"-"- '],
  blink: ['  ,_,  ', ' (-,-) ', ' (   ) ', ' -"-"- '],
  look: ['  ,_,  ', ' (O,O) ', ' (   ) ', ' -"-"- '],
  sleep: ['  ,_,  ', ' (-,-) ', ' (   ) ', ' -"-"- '],
  cheer: ['  ,_,  ', '\\(^,^)/', ' (   ) ', ' -"-"- '],
  error: ['  ,_,  ', ' (x,x) ', ' (   ) ', ' -"-"- '],
};

// speed: columns per frame; hop: chance per frame to jump when on the ground; wander: chance to start/stop walking.
const MOODS = {
  idle: { speed: 0.3, hop: 0.01, jump: 1.0, wander: 0.02 },
  poll: { speed: 0.9, hop: 0.2, jump: 1.2, wander: 0 },
  review: { speed: 0.45, hop: 0.05, jump: 1.0, wander: 0 },
  cheer: { speed: 0.6, hop: 1, jump: 1.6, wander: 0 },
  sleep: { speed: 0, hop: 0, jump: 0, wander: 0 },
  error: { speed: 0, hop: 0, jump: 0, wander: 0 },
};

function spriteFor(mood, dir, frame) {
  if (SPRITES[mood]) return SPRITES[mood];
  if (mood === 'review') return SPRITES.look;
  if (mood === 'poll') return frame % 10 < 5 ? SPRITES.look : SPRITES.idle;
  return frame % 40 < 2 ? SPRITES.blink : SPRITES.idle;
}

function cellStyle(row, ch) {
  if (row === 1 && 'oO-^x'.includes(ch)) return C.eye;
  if (row === 1 && ch === ',') return C.beak;
  if (row === 3) return C.beak;
  return C.body;
}

/** `text` word-wrapped to `w` columns, at most `max` lines (the last one cut short with …); [] if it can't fit. */
export function wrap(text, w, max) {
  if (w < 8 || max < 1) return [];
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let rest = [...word]; rest.length;) {
      const gap = line ? 1 : 0;
      const take = Math.min(rest.length, w - [...line].length - gap);
      if (take < rest.length && (line || take <= 0)) { lines.push(line); line = ''; continue; } // start a new line
      line += (gap ? ' ' : '') + rest.slice(0, take).join('');
      rest = rest.slice(take);
    }
  }
  if (line) lines.push(line);
  if (lines.length > max) lines.splice(max - 1, Infinity, `${[...lines[max - 1]].slice(0, w - 1).join('')}…`);
  return lines;
}

export function createMascot(random = Math.random) {
  let x = 2;
  let dir = 1;
  let y = 0; // rows above the ground
  let vy = 0;
  let frame = 0;
  let walking = true;
  let say = '';
  let particles = [];

  function step(width, height, mood, speech) {
    const m = MOODS[mood] || MOODS.idle;
    const w = spriteFor(mood, dir, frame)[0].length;
    const headroom = Math.max(0, height - 1 - 4);
    frame++;
    if (m.wander && random() < m.wander) walking = !walking;
    x += dir * (m.wander && !walking ? 0 : m.speed);
    if (x <= 0) { x = 0; dir = 1; }
    if (x >= width - w) { x = Math.max(0, width - w); dir = -1; }
    if (y > 0 || vy > 0) {
      y = Math.min(headroom, y + vy);
      vy -= 0.3;
      if (y <= 0) { y = 0; vy = 0; }
    } else if (random() < m.hop) {
      vy = m.jump;
    }

    const top = height - 1 - 4 - Math.round(y);
    const spawn = (ch, style, vx, pvy, g, life, px = x + w / 2) => particles.push({ x: px, y: top, ch, style, vx, vy: pvy, g, life });
    if (mood === 'sleep' && frame % 18 === 0) spawn('z', C.z, 0.12, -0.08, 0, 30, x + w - 1);
    if (mood === 'cheer') for (let i = 0; i < 2; i++) spawn('*+.o'[Math.floor(random() * 4)], CONFETTI[Math.floor(random() * 5)], (random() - 0.5) * 1.6, -0.5 - random() * 0.3, 0.07, 25);
    if (mood === 'review' && frame % 40 === 0 && random() < 0.4) spawn(random() < 0.5 ? '?' : '!', C.alert, 0, -0.1, 0, 15);
    if (mood === 'error' && frame % 30 === 0) spawn('!', C.alert, 0, -0.1, 0, 12);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.g;
      p.life--;
      if (p.ch === 'z' && p.life < 15) p.ch = 'Z';
    }
    particles = particles.filter(p => p.life > 0 && p.y >= 0 && p.y < height - 1 && p.x >= 0 && p.x < width);
    say = speech || '';
  }

  function draw(width, height, mood) {
    const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => [' ', '']));
    const put = (r, c, ch, style) => { if (r >= 0 && r < height && c >= 0 && c < width) grid[r][c] = [ch, style]; };
    for (let c = 0; c < width; c++) {
      const ch = GROUND[c % GROUND.length];
      put(height - 1, c, ch, ch === '_' ? C.dirt : C.grass);
    }
    for (const p of particles) put(Math.round(p.y), Math.round(p.x), p.ch, p.style);
    const sprite = spriteFor(mood, dir, frame);
    const sx = Math.round(x);
    const top = height - 1 - sprite.length - Math.round(y);
    sprite.forEach((line, r) => [...line].forEach((ch, c) => { if (ch !== ' ') put(top + r, sx + c, ch, cellStyle(r, ch)); }));
    if (say) {
      // A speech box beside Hoot, on whichever side has room, wrapped to at most 3 lines.
      const right = width - (sx + sprite[0].length + 1);
      const lines = wrap(say, Math.min(56, Math.max(right, sx - 1)) - 4, Math.min(3, height - 3));
      const inner = Math.max(0, ...lines.map(l => [...l].length));
      const box = [`╭${'─'.repeat(inner + 2)}╮`, ...lines.map(l => `│ ${l}${' '.repeat(inner - [...l].length)} │`), `╰${'─'.repeat(inner + 2)}╯`];
      const col = right >= inner + 4 ? sx + sprite[0].length + 1 : sx - inner - 5;
      const row = Math.max(0, Math.min(top, height - 1 - box.length));
      if (lines.length && col >= 0) box.forEach((line, r) => [...line].forEach((ch, c) => put(row + r, col + c, ch, C.bubble)));
    }
    return grid.map(cells => {
      const segs = [];
      for (const [ch, style] of cells) {
        if (segs.length && segs[segs.length - 1][0] === style) segs[segs.length - 1][1] += ch;
        else segs.push([style, ch]);
      }
      return segs;
    });
  }

  return {
    /** Advances the animation one frame (when `advance`) and draws it. */
    render(width, height, mood, speech, advance = true) {
      if (advance) step(width, height, mood, speech);
      return draw(width, height, mood);
    },
  };
}
