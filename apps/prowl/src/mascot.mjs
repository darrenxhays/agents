// Hoot, the reviewing owl. He keeps to one spot on his patch of ground at the left of the scene strip, and what he does
// there follows his mood and how much he has on: asleep with nothing to do, glancing about while he talks, hovering
// with flapping wings while the boards are checked, reading one review, juggling two to four, typing away at five or
// more, bouncing when something is done, and sitting under a rain cloud when something went wrong. His speech box goes
// beside him. render() returns `height` rows of [style, text].

const C = {
  body: '\x1b[38;5;180m', eye: '\x1b[1;38;5;220m', beak: '\x1b[38;5;208m', grass: '\x1b[38;5;71m', dirt: '\x1b[38;5;95m',
  bubble: '\x1b[38;5;250m', z: '\x1b[38;5;111m', alert: '\x1b[1;38;5;203m', book: '\x1b[38;5;223m', laptop: '\x1b[38;5;110m',
  screen: '\x1b[38;5;114m', cloud: '\x1b[38;5;247m', rain: '\x1b[38;5;75m', sweat: '\x1b[38;5;117m', spark: '\x1b[38;5;229m', trail: '\x1b[38;5;240m',
};
const CONFETTI = ['\x1b[38;5;220m', '\x1b[38;5;203m', '\x1b[38;5;114m', '\x1b[38;5;75m', '\x1b[38;5;176m'];
const GROUND = "_,_._'__._,_.__'_,__._";
const CODE = 'if(ok){ship()} => 0x1f; [x for x in prs] && review(); ';
const W_OWL = 7; // every pose is 7 columns wide and 4 rows tall
const LAPTOP = 8; // the laptop's columns beside him, gap included

/** A pose: `eyes` 3 characters, `up` the wings beside his face, `side` beside his body, `body` 3 and `feet` 5 characters. */
const owl = ({ eyes = 'o,o', up = '  ', side = '  ', body = '   ', feet = '-"-"-', ears = ',_,' } = {}) =>
  [`  ${ears}  `, `${up[0]}(${eyes})${up[1]}`, `${side[0]}(${body})${side[1]}`, ` ${feet} `];

function cellStyle(row, ch, mood) {
  if (row === 1 && 'oO-^x<>.°'.includes(ch)) return mood === 'error' ? C.alert : C.eye;
  if ((row === 1 || row === 3) && ch === ',') return C.beak;
  if (row === 3) return C.beak;
  if (row === 2 && '[]=/|\\'.includes(ch) && mood === 'review') return C.book;
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

/** What he's up to: the mood, and for reviews how many: 1 reads, 2–4 juggle, 5 or more type. */
const activity = (mood, busy) => (mood !== 'review' ? mood : busy >= 5 ? 'type' : busy >= 2 ? 'juggle' : 'read');

/** His patch of ground: `patch` columns when given, else the left quarter of `width`, never narrower than him and his laptop. */
const zone = (width, patch) => Math.max(W_OWL + LAPTOP, patch || Math.floor(width / 4));
/** His spot: the middle of his patch, a little to the left when his laptop is out, so that it stays on the ground too. */
const spot = (width, patch, now) => {
  const home = Math.floor((zone(width, patch) - W_OWL) / 2);
  return now === 'type' ? Math.min(home, zone(width, patch) - W_OWL - LAPTOP) : home;
};

export function createMascot(random = Math.random) {
  let x = 0;
  let y = 0; // rows above the ground
  let vy = 0;
  let frame = 0;
  let doing = '';
  let idle = { act: 'still', left: 0 }; // the idle bit he's doing, and for how many frames more
  let particles = [];
  let say = '';

  const spawn = (px, py, ch, style, vx, pvy, g, life) => particles.push({ x: px, y: py, ch, style, vx, vy: pvy, g, life });

  function step(width, height, mood, busy, speech, patch) {
    frame++;
    const now = activity(mood, busy);
    if (now !== doing) { doing = now; idle = { act: 'still', left: 0 }; frame = 0; }
    const headroom = Math.max(0, height - 1 - 4);
    x = spot(width, patch, now);
    const top = () => height - 1 - 4 - Math.round(y);
    const fall = () => {
      if (y > 0 || vy > 0) { y = Math.min(headroom, y + vy); vy -= 0.3; if (y <= 0) { y = 0; vy = 0; } }
    };

    if (now === 'sleep') {
      y = 0;
      if (frame % 18 === 0) spawn(x + W_OWL - 1, top(), 'z', C.z, 0.12, -0.08, 0, 30);
      if (frame % 60 === 30) spawn(x + 4, top() + 1, 'o', C.z, 0.05, -0.04, 0, 14); // a snore bubble
    } else if (now === 'idle') {
      // Little bits of business, one after another, on the spot: glancing about, a wink, a stretch, a flap, a bounce.
      if (--idle.left <= 0) {
        const act = ['still', 'still', 'look', 'look', 'wink', 'stretch', 'flap', 'bounce'][Math.floor(random() * 8)];
        idle = { act, left: { still: 40, look: 40, wink: 8, stretch: 18, flap: 16, bounce: 10 }[act] };
        if (act === 'bounce' && y === 0) vy = 0.8;
      }
      fall();
    } else if (now === 'poll') {
      // Hovering over his spot with his wings going, peering about for new work.
      y = Math.max(0, Math.min(headroom, 1 + Math.sin(frame / 3)));
      if (frame % 4 === 0) spawn(x + 1 + random() * 5, top() + 4, '~', C.trail, 0, 0.2, 0, 3); // the downdraft
      if (frame % 25 === 0) spawn(x + 3, top() - 1, '?', C.alert, 0, -0.1, 0, 10);
    } else if (now === 'read') {
      // Reading the review open in his wings, now and then struck by something.
      y = 0;
      if (frame % 50 === 47) spawn(x + 5, top() - 1, '!', C.alert, 0.05, -0.12, 0, 10);
    } else if (now === 'juggle') {
      y = 0;
    } else if (now === 'type') {
      y = 0;
      if (frame % 2 === 0) spawn(x + W_OWL + 3 + random() * 3, height - 2, random() < 0.5 ? '*' : '+', C.spark, (random() - 0.5) * 0.6, -0.35, 0.05, 5);
      if (frame % 14 === 0) spawn(x + (random() < 0.5 ? 0 : W_OWL - 1), top(), '°', C.sweat, random() < 0.5 ? -0.35 : 0.35, -0.3, 0.08, 12);
    } else if (now === 'cheer') {
      if (y === 0 && random() < 0.3) vy = 1.0; // bouncing on the spot
      fall();
      for (let i = 0; i < 2; i++) spawn(x + 3, top(), '*+.o'[Math.floor(random() * 4)], CONFETTI[Math.floor(random() * 5)], (random() - 0.5) * 1.6, -0.5 - random() * 0.3, 0.07, 25);
    } else if (now === 'error') {
      y = 0;
      const cloud = Math.max(0, top() - 2);
      if (random() < 0.7) spawn(x + 1 + Math.floor(random() * 5), cloud + 1, "'", C.rain, 0, 0.6, 0, 3);
      if (frame % 30 === 0) spawn(x + 6, top(), '!', C.alert, 0.1, -0.1, 0, 12);
    }

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.g;
      p.life--;
      if (p.ch === 'z' && p.life < 15) p.ch = 'Z';
      if (p.ch === 'o' && p.style === C.z && p.life < 7) p.ch = 'O';
    }
    particles = particles.filter(p => p.life > 0 && p.y >= 0 && p.y < height - 1 && p.x >= 0 && p.x < width);
    say = speech || '';
  }

  /** His pose this frame. */
  function pose(now) {
    const t = frame;
    if (now === 'sleep') return owl({ eyes: '-,-', ears: t % 40 < 20 ? ',_,' : ',-,' }); // breathing
    if (now === 'poll') return t % 4 < 2 ? owl({ eyes: 'O,O', up: '\\/', feet: ' " " ' }) : owl({ eyes: 'O,O', side: '/\\', feet: ' " " ' });
    if (now === 'read') {
      const flip = t % 50; // a page turns every few seconds
      const page = flip < 2 ? '[/]' : flip < 4 ? '[|]' : flip < 6 ? '[\\]' : '[=]';
      return owl({ eyes: t % 70 < 3 ? '-,-' : t % 16 < 8 ? '.,.' : 'o,o', body: page, feet: t % 20 < 10 ? '-"-"-' : '"-"-"' });
    }
    if (now === 'juggle') return owl({ eyes: 'o,o', up: t % 6 < 3 ? '\\/' : '__' });
    if (now === 'type') return owl({ eyes: t % 30 < 2 ? '-,-' : 'o,o', side: t % 2 ? '-=' : '=-' });
    if (now === 'cheer') return t % 6 < 3 ? owl({ eyes: '^,^', up: '\\/' }) : owl({ eyes: '^,^', side: '/\\', feet: '"-"-"' });
    if (now === 'error') return owl({ eyes: t % 20 < 10 ? 'x,x' : '>,<', side: t % 4 < 2 ? '~ ' : ' ~' });
    const { act, left } = idle; // idle
    if (act === 'look') return owl({ eyes: left > 20 ? '<,<' : '>,>' });
    if (act === 'wink') return owl({ eyes: '-,o' });
    if (act === 'stretch') return owl({ eyes: '^,^', up: '\\/' });
    if (act === 'flap') return t % 4 < 2 ? owl({ up: '\\/' }) : owl({ side: '/\\' });
    if (act === 'bounce') return owl({ eyes: '^,^', feet: '"-"-"' });
    return owl({ eyes: t % 40 < 2 ? '-,-' : 'o,o' }); // blinking now and then
  }

  function draw(width, height, mood, busy, patch) {
    const now = activity(mood, busy);
    const ground = Math.min(width, zone(width, patch));
    const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => [' ', '']));
    const put = (r, c, ch, style) => { if (r >= 0 && r < height && c >= 0 && c < width) grid[r][c] = [ch, style]; };
    const text = (r, c, s, style) => [...s].forEach((ch, i) => { if (ch !== ' ') put(r, c + i, ch, style); });
    for (let c = 0; c < ground; c++) { // his patch only: the rest of the strip is for the speech box and the cards
      const ch = GROUND[c % GROUND.length];
      put(height - 1, c, ch, ch === '_' ? C.dirt : C.grass);
    }
    for (const p of particles) put(Math.round(p.y), Math.round(p.x), p.ch, p.style);
    const sprite = pose(now);
    const shake = now === 'error' && frame % 30 < 8 ? (frame % 2 ? 1 : -1) : 0;
    const sx = Math.max(0, spot(width, patch, now) + shake);
    const top = height - 1 - sprite.length - Math.round(y);
    let right = sx + W_OWL; // the first column clear of him and his things, for the speech box

    if (now === 'juggle') {
      // A shower: each ball arcs over his head from his left wing to his right, and comes back low.
      const n = Math.min(busy, 4);
      const [hl, hr, hand] = [sx, sx + W_OWL - 1, top + 1];
      const peak = Math.max(0, top - 2);
      for (let i = 0; i < n; i++) {
        const p = (frame / (26 - n * 3) + i / n) % 1;
        const [bx, by] = p < 0.72
          ? [hl + (p / 0.72) * (hr - hl), hand - (hand - peak) * 4 * (p / 0.72) * (1 - p / 0.72)]
          : [hr - ((p - 0.72) / 0.28) * (hr - hl), hand];
        put(Math.round(by), Math.round(bx), 'o', `\x1b[1m${CONFETTI[i % CONFETTI.length]}`);
      }
    }
    if (now === 'type') {
      // A laptop beside him, its screen scrolling code.
      const lx = sx + LAPTOP;
      const code = [...CODE.repeat(2)].slice(frame % CODE.length, (frame % CODE.length) + 5).join('');
      text(height - 4, lx, '.-----.', C.laptop);
      put(height - 3, lx, '|', C.laptop);
      text(height - 3, lx + 1, code, C.screen);
      put(height - 3, lx + 6, '|', C.laptop);
      text(height - 2, lx - 1, "'=======", C.laptop);
      right = lx + 7;
    }
    if (now === 'error') text(Math.max(0, top - 2), sx, ' (~~~) ', C.cloud);
    sprite.forEach((line, r) => [...line].forEach((ch, c) => { if (ch !== ' ') put(top + r, sx + c, ch, cellStyle(r, ch, now === 'read' ? 'review' : mood)); }));

    if (say) {
      // A speech box to his right, wrapped to at most 3 lines, in what's left of `width`.
      const room = Math.min(56, width - right - 1);
      const lines = wrap(say, room - 4, Math.min(3, height - 3));
      const inner = Math.max(0, ...lines.map(l => [...l].length));
      const box = [`╭${'─'.repeat(inner + 2)}╮`, ...lines.map(l => `│ ${l}${' '.repeat(inner - [...l].length)} │`), `╰${'─'.repeat(inner + 2)}╯`];
      const row = Math.max(0, Math.min(top, height - 1 - box.length));
      if (lines.length) box.forEach((line, r) => [...line].forEach((ch, c) => put(row + r, right + 1 + c, ch, C.bubble)));
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
    /**
     * Advances the animation one frame (when `advance`) and draws it, `width` columns wide. `busy`: how many sessions
     * are running. `patch`: the columns of ground that are his, the left quarter when not given; his speech box uses
     * the rest of `width`.
     */
    render(width, height, mood, speech, advance = true, busy = 0, patch = 0) {
      if (advance) step(width, height, mood, busy, speech, patch);
      return draw(width, height, mood, busy, patch);
    },
    /** Where he is, for the self-test: his column, the activity, and the right edge of his patch. */
    at: (width, patch) => ({ x, doing, zone: zone(width, patch) }),
  };
}
