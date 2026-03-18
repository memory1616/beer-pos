const fs = require('fs');

let content = fs.readFileSync('./routes/expenses.js', 'utf8');

// Fix string concatenations
content = content.replace(/optionsHtml \+/g, "' + optionsHtml + '");
content = content.replace(/categoryHtml \+/g, "' + categoryHtml + '");
content = content.replace(/expensesHtml \+/g, "' + expensesHtml + '");

fs.writeFileSync('./routes/expenses.js', content);
console.log('Fixed!');
