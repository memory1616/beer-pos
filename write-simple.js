const fs = require('fs');

const content = `let x = 1;
console.log(x);
`;

const dest = 'public/js/dashboard.js';
fs.writeFileSync(dest, content);
console.log('Done');
