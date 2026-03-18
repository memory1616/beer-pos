const fs = require('fs');
const { execSync } = require('child_process');

try {
  // Get file from git
  const content = execSync('git show 469e070:routes/expenses.js', { encoding: 'utf8', timeout: 10000 });
  
  // Fix the string concatenation issues
  let fixed = content;
  
  // Fix: optionsHtml +  --> ' + optionsHtml + '
  fixed = fixed.replace(/optionsHtml \+/g, "' + optionsHtml + '");
  
  // Fix: categoryHtml +  --> ' + categoryHtml + '
  fixed = fixed.replace(/categoryHtml \+/g, "' + categoryHtml + '");
  
  // Fix: expensesHtml +  --> ' + expensesHtml + '
  fixed = fixed.replace(/expensesHtml \+/g, "' + expensesHtml + '");
  
  // Write fixed file
  fs.writeFileSync('./routes/expenses.js', fixed, 'utf8');
  console.log('Fixed and written!');
  
  // Test syntax
  require('./routes/expenses.js');
  console.log('Syntax OK!');
} catch (e) {
  console.error('Error:', e.message);
}
