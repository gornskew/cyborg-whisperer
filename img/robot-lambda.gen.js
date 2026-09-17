// Emits the Cyborg Whisperer logo: the classic GDL box robot (the
// 2002 training example, palette from the demos render) wearing a
// lambda on its chest.  Cabinet projection, three faces per box.
//   node robot-lambda.gen.js > robot-lambda.svg   (then rasterize; see the commit)
const k = 0.45, ox = 44, oy = 604;
const P = (x, y, z) => [ox + x + k * z, oy - y - k * z].map(v => v.toFixed(1)).join(',');
const shade = (hex, f) => '#' + [1, 3, 5].map(i => {
  const c = Math.round(Math.min(255, parseInt(hex.slice(i, i + 2), 16) * f));
  return c.toString(16).padStart(2, '0');
}).join('');
const face = (pts, fill) =>
  `<polygon points="${pts.join(' ')}" fill="${fill}" stroke="#000" stroke-opacity="0.35" stroke-width="1.5" stroke-linejoin="round"/>`;
function box(x0, x1, y0, y1, z0, z1, c) {
  return [
    face([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], shade(c, 1.28)), // top
    face([P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0)], shade(c, 0.62)), // right side
    face([P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0)], c),              // front
  ].join('\n');
}
const parts = [
  // ground shadow
  `<ellipse cx="${ox + 225}" cy="${oy + 4}" rx="215" ry="34" fill="#000" opacity="0.12"/>`,
  box(60, 300, 0, 16, 0, 200, '#e8a200'),      // base plate
  box(165, 195, 16, 172, 85, 115, '#e8a200'),  // post
  box(62, 90, 186, 398, 78, 122, '#a6f000'),   // left arm (green)
  box(64, 76, 160, 186, 84, 116, '#c9c9c9'),   // left gripper fingers
  box(78, 90, 160, 186, 84, 116, '#c9c9c9'),
  box(90, 270, 172, 410, 40, 160, '#1a1aff'),  // torso
  box(270, 298, 186, 398, 78, 122, '#ff1f1f'), // right arm (red)
  box(272, 284, 160, 186, 84, 116, '#c9c9c9'), // right gripper fingers
  box(286, 298, 160, 186, 84, 116, '#c9c9c9'),
  box(140, 220, 410, 470, 70, 130, '#00e5e5'), // head
  // eyes on the head's front face
  `<rect x="${ox + 152 + k * 70}" y="${oy - 452 - k * 70}" width="14" height="10" fill="#003c3c"/>`,
  `<rect x="${ox + 194 + k * 70}" y="${oy - 452 - k * 70}" width="14" height="10" fill="#003c3c"/>`,
  // the lambda, on the torso's front face
  `<text x="${ox + 180 + k * 40}" y="${oy - 236 - k * 40}" text-anchor="middle" font-family="Georgia, 'DejaVu Serif', 'Times New Roman', serif" font-weight="bold" font-size="168" fill="#fff" fill-opacity="0.96">λ</text>`,
];
process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 640" width="480" height="640">
<title>Cyborg Whisperer: a lambda-bearing robot</title>
${parts.join('\n')}
</svg>
`);
