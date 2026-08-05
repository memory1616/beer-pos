// Debug
const year = 2026;
const rx = new RegExp('tháng\\s+(\\d{1,2})/(' + year + ')(?!\\d)');
console.log('Regex source:', rx.source);
console.log('Note:', 'tháng 7/2026');
console.log('Match:', 'tháng 7/2026'.match(rx));

const alt = /tháng\s+(\d{1,2})\/(2026)(?!\d)/;
console.log('Alt match:', 'tháng 7/2026'.match(alt));
