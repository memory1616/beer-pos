// Test B18 thật
function makeRx(year) {
  return new RegExp("tháng\\s+(\\d{1,2})/(" + year + ")(?!\\d)");
}

const rx2026 = makeRx(2026);

// Test trực tiếp bằng cách escape unicode
const note1 = 'Tra thuong san luong ' + 'tháng' + ' 7/' + '2026' + ' - khach A';
console.log('Note1:', note1);
console.log('Note1 length:', note1.length);
console.log('Match:', note1.match(rx2026));
console.log('Chars at "thang" position:');
for (let i = 0; i < note1.length; i++) {
  if (i > 18 && i < 35) console.log('  ['+i+'] char='+note1.charCodeAt(i)+' "'+note1[i]+'"');
}
