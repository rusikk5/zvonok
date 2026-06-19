'use strict';
/* ================================================================
   PIXEL ART — Minecraft-style sprites & landscape
   ================================================================ */
const hex2rgb = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
const _shade = (h, k) => {
  const [r,g,b] = hex2rgb(h);
  const f = v => Math.max(0, Math.min(255, Math.round(v*k)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
};

function drawSprite(canvas, spr, pal, seed=1){
  const ctx = canvas.getContext('2d');
  let s = seed;
  const rnd = () => (s = (s*16807)%2147483647) / 2147483647;
  for(let y=0; y<8; y++){
    for(let x=0; x<8; x++){
      const c = pal[spr[y][x]];
      for(let dy=0; dy<2; dy++) for(let dx=0; dx<2; dx++){
        const k = 0.94 + rnd()*0.12;
        ctx.fillStyle = c ? _shade(c, k) : `rgba(255,255,255,${0.06+rnd()*0.05})`;
        ctx.fillRect(x*2+dx, y*2+dy, 1, 1);
      }
    }
  }
}

const PAL = {
  steve:   {'.':null,'h':'#4a2f1c','s':'#cf9069','d':'#b07349','w':'#ffffff','b':'#3b2d8f','m':'#6e4226','t':'#0aa3a3'},
  rusik:   {'.':null,'h':'#241a12','s':'#d8a071','d':'#b6804f','w':'#ffffff','b':'#27313f','m':'#7a4a2a','t':'#caa46a'},
  garfield:{'.':null,'o':'#ef8c2e','r':'#c4641c','w':'#fff7e0','b':'#1c1c1c','p':'#f6c896','m':'#8a4a1a'},
  creeper: {'.':'#3fae4e','l':'#5ecb6c','d':'#2e8a3c','k':'#0c1c10'},
  grass:   {'g':'#5cab46','l':'#79cc5e','d':'#7a5230','e':'#5e3d22'},
  owl:     {'.':null,'b':'#3a2a10','f':'#c8a040','w':'#ffffff','e':'#1a1a1a','o':'#e8b840','t':'#7a5020'},
  cat:     {'.':null,'o':'#d06010','w':'#f0e8d0','b':'#1a1a1a','p':'#f0b0a0','s':'#e89030'},
};
const SPR = {
  steve:   ['hhhhhhhh','hhhhhhhh','hssssssh','ssssssss','wbssssbw','ssssddss','ssdmmdss','tttttttt'],
  rusik:   ['.hhhhhh.','hhhhhhhh','hssssssh','ssssssss','wbssssbw','ssddddss','ssdmmdss','tttttttt'],
  garfield:['o......o','oo.rr.oo','oooooooo','wboooobw','oorrrroo','oppppppo','oppmmppo','oorrrroo'],
  creeper: ['lll..lll','l..ll..l','kk....kk','kk....kk','..kkkk..', '.kkddkk.','.kk..kk.','d..ll..d'],
  grass:   ['llgggllg','gggggggg','ddddeedd','deeddeed','ddeeddde','eedddeed','ddeeddde','eeddeedd'],
  owl:     ['..bbb...','..bfb...','b.www.b.','bbewebb.','.bbbbb..','..bbb...','..b.b...','..t.t...'],
  cat:     ['.oo.oo..','oooooooo','owooowoo','obwwwboo','ooppppoo','oowwwwoo','ooooooo.','ot...to.'],
};

window.PAL = PAL;
window.SPR = SPR;
window.drawSprite = drawSprite;

/* ================================================================
   LANDSCAPE
   ================================================================ */
function mulberry(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function drawLandscape(canvas, opts={}){
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const rnd = mulberry(opts.seed || 42);

  for(let y=0; y<H; y++){
    const t = y / H;
    ctx.fillStyle = `rgb(${Math.round(146-30*t)},${Math.round(206-40*t)},${Math.round(222-62*t)})`;
    ctx.fillRect(0, y, W, 1);
  }
  const sx = Math.floor(W*0.78), sy = Math.floor(H*0.10), ss = Math.max(4, Math.floor(W/22));
  ctx.fillStyle = 'rgba(255,250,200,0.35)'; ctx.fillRect(sx-1, sy-1, ss+2, ss+2);
  ctx.fillStyle = '#fff3a8'; ctx.fillRect(sx, sy, ss, ss);

  for(let i=0; i<Math.max(4, W/22); i++){
    const cx = Math.floor(rnd()*W), cy = Math.floor(rnd()*H*0.28);
    const len = 3+Math.floor(rnd()*6);
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(cx, cy, len, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.fillRect(cx-1, cy+2, len+2, 1);
  }

  let ground = Math.floor(H*0.62);
  const lakeFrom = Math.floor(W*0.40), lakeTo = Math.floor(W*0.55);
  for(let x=0; x<W; x++){
    ground += Math.round((rnd()-0.5)*2.2);
    ground = Math.max(Math.floor(H*0.46), Math.min(Math.floor(H*0.80), ground));
    const inLake = x>=lakeFrom && x<=lakeTo;
    if(inLake){
      const wl = Math.floor(H*0.66);
      for(let y=wl; y<H; y++){
        const deep = y-wl;
        ctx.fillStyle = deep<2 ? '#7fd4ea' : (rnd()>0.5 ? '#3f86d6' : '#3578c4');
        ctx.fillRect(x, y, 1, 1);
      }
      continue;
    }
    ctx.fillStyle = '#8ee06a'; ctx.fillRect(x, ground, 1, 1);
    ctx.fillStyle = rnd()>0.5 ? '#5cab46' : '#69ba50'; ctx.fillRect(x, ground+1, 1, 2);
    for(let y=ground+3; y<H; y++){
      const deep = y-ground;
      if(deep < 6) ctx.fillStyle = rnd()>0.5 ? '#7a5230' : '#6a4628';
      else if(deep < 14) ctx.fillStyle = rnd()>0.6 ? '#777' : '#666';
      else ctx.fillStyle = rnd()>0.7 ? '#4f4f4f' : '#585858';
      if(deep>8 && rnd()<0.015) ctx.fillStyle = rnd()>0.5 ? '#3aa0ff' : '#ffd34d';
      ctx.fillRect(x, y, 1, 1);
    }
    if(rnd() < 0.05 && ground > H*0.50 && x>2 && x<W-3){
      const th = 4+Math.floor(rnd()*3);
      ctx.fillStyle = '#5e3d22'; ctx.fillRect(x, ground-th, 1, th);
      ctx.fillStyle = '#3f8f33'; ctx.fillRect(x-2, ground-th-3, 5, 4);
      ctx.fillStyle = '#4da33f'; ctx.fillRect(x-1, ground-th-4, 3, 2);
      ctx.fillStyle = '#5cb84a'; ctx.fillRect(x, ground-th-5, 1, 1);
    }
  }
}

window.drawLandscape = drawLandscape;
window.mulberry = mulberry;

/* ================================================================
   BACKGROUND CANVAS
   ================================================================ */
const bg = document.getElementById('bg');
function paintBg(){
  if(!bg) return;
  bg.width  = 280;
  bg.height = Math.max(80, Math.round(280 * innerHeight / innerWidth));
  drawLandscape(bg, {seed: 1337});
}
paintBg();
addEventListener('resize', paintBg);

/* ================================================================
   FLOATING CUBES
   ================================================================ */
const cubesCv = document.getElementById('cubes');
if(cubesCv){
  const cctx = cubesCv.getContext('2d');
  const cubeSprite = document.createElement('canvas');
  cubeSprite.width = 16; cubeSprite.height = 16;
  drawSprite(cubeSprite, SPR.grass, PAL.grass, 7);

  const cubes = Array.from({length:10}, (_,i)=>({
    x: Math.random(), y: Math.random(),
    size: 18 + Math.random()*30,
    vy: 0.06 + Math.random()*0.10,
    drift: (Math.random()-0.5)*0.04,
    rot: Math.random()*Math.PI*2,
    vr: (Math.random()-0.5)*0.004
  }));

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function paintCubes(){ cubesCv.width = innerWidth; cubesCv.height = innerHeight; }
  paintCubes();
  addEventListener('resize', paintCubes);

  function tick(){
    cctx.clearRect(0,0,cubesCv.width,cubesCv.height);
    cctx.imageSmoothingEnabled = false;
    for(const c of cubes){
      if(!reduceMotion){
        c.y -= c.vy / innerHeight;
        c.x += c.drift / innerWidth * 60;
        c.rot += c.vr;
        if(c.y < -0.08){ c.y = 1.08; c.x = Math.random(); }
      }
      const px = c.x*innerWidth, py = c.y*innerHeight;
      cctx.save();
      cctx.translate(px, py);
      cctx.rotate(c.rot);
      cctx.globalAlpha = 0.85;
      cctx.drawImage(cubeSprite, -c.size/2, -c.size/2, c.size, c.size);
      cctx.restore();
    }
    requestAnimationFrame(tick);
  }
  tick();
}

/* draw all static [data-pix] canvases */
document.querySelectorAll('canvas[data-pix]').forEach((c,i)=>{
  const kind = c.dataset.pix;
  if(kind === 'landscape') drawLandscape(c, {seed:99});
  else if(kind === 'landscape-mini') drawLandscape(c, {seed:5});
  else if(SPR[kind]) drawSprite(c, SPR[kind], PAL[kind], 3+i);
});
