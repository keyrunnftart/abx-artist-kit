// minimal ABX p5 sketch: every random number comes from the mint seed
const td = abx.tokenData;
const s = parseInt(td.seed.slice(2, 10), 16);
function setup() {
  createCanvas(1000, 1000);

  noLoop();
}
function draw() {
  background(12);
  noFill();
  const n = floor(random(20, 60));
  for (let i = 0; i < n; i++) {
    stroke(random(255), random(120, 255), 200, 180);
    strokeWeight(random(1, 6));
    circle(random(width), random(height), random(40, 400));
  }
  abx.traits({ Rings: n > 40 ? 'Many' : 'Few' });
  abx.done();
}
