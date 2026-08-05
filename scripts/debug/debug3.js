function makeRx(year) {
  return new RegExp("tháng\\s+(\\d{1,2})/(" + year + ")(?!\\d)");
}

const note = 'Tra thuong san luong tháng 1/2026';
const rx2027 = makeRx(2027);
console.log('rx2027 source:', rx2027.source);
console.log('Note:', note);
console.log('Match result:', note.match(rx2027));
