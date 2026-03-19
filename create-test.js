const fs = require('fs');
const content = `let name = "Tên";
console.log(name);
`;
fs.writeFileSync('testvn.js', content);
console.log('Done');
