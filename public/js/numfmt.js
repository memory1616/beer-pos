/**
 * Format number input with thousand separators
 * - Automatically adds commas while typing
 * - Keeps cursor position stable
 * - Supports both integers and decimals
 * 
 * Usage:
 *   // Method 1: Add data-format-number attribute
 *   <input type="text" data-format-number>
 *   
 *   // Method 2: Manual event listeners
 *   <input type="text" oninput="formatNumberInput(this)" onblur="formatNumberInput(this, true)">
 *   
 *   // Method 3: Initialize manually
 *   document.querySelectorAll('input.amount').forEach(el => initNumberFormat(el))
 */

// Main format function
function formatNumberInput(input, forceFormat = false) {
  const isFocused = document.activeElement === input;
  
  // Get cursor position relative to unformatted value
  let cursorOffset = 0;
  if (isFocused) {
    cursorOffset = getCursorOffset(input);
  }
  
  // Get raw value (remove all non-numeric except decimal point)
  let rawValue = input.value.replace(/[^0-9.]/g, '');
  
  // Handle multiple decimal points - keep only first
  const decimalParts = rawValue.split('.');
  if (decimalParts.length > 2) {
    rawValue = decimalParts[0] + '.' + decimalParts.slice(1).join('');
  }
  
  // If empty or just decimal point
  if (!rawValue || rawValue === '.') {
    input.value = forceFormat ? '0' : '';
    return;
  }
  
  // Parse the number
  const num = parseFloat(rawValue);
  if (isNaN(num)) {
    input.value = '';
    return;
  }
  
  // Format the number
  let formatted;
  const hasDecimal = rawValue.includes('.');
  const decimalIndex = rawValue.indexOf('.');
  const decimalPart = hasDecimal ? rawValue.substring(decimalIndex + 1) : '';
  
  if (hasDecimal && decimalPart) {
    // Format integer part with commas, keep decimal as-is
    const integerPart = decimalParts[0];
    formatted = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + decimalPart;
  } else {
    // Format integer only
    formatted = rawValue.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  
  // Update value
  const oldValue = input.value;
  input.value = formatted;
  
  // Adjust cursor position after formatting
  if (isFocused && oldValue !== formatted) {
    adjustCursor(input, cursorOffset, oldValue, formatted);
  }
}

// Get cursor offset from end of input
function getCursorOffset(input) {
  const val = input.value;
  const selStart = input.selectionStart;
  const formattedCharsBefore = val.substring(0, selStart).replace(/[^0-9]/g, '').length;
  return formattedCharsBefore;
}

// Adjust cursor position after formatting
function adjustCursor(input, targetOffset, oldValue, newValue) {
  // Count formatted characters up to target offset
  let newPos = 0;
  let charCount = 0;
  
  for (let i = 0; i < newValue.length && charCount < targetOffset; i++) {
    if (newValue[i].match(/[0-9]/)) {
      charCount++;
    }
    newPos = i + 1;
  }
  
  // If we're at a comma, move past it
  while (newPos < newValue.length && newValue[newPos] === ',') {
    newPos++;
  }
  
  // Set cursor position
  try {
    input.setSelectionRange(newPos, newPos);
  } catch (e) {
    // Ignore errors
  }
}

// Format on blur (ensure clean format)
function formatOnBlur(input) {
  formatNumberInput(input, true);
}

// Parse formatted number to raw number (for form submission)
function parseFormattedNumber(value) {
  if (!value) return 0;
  const num = parseFloat(value.replace(/,/g, ''));
  return isNaN(num) ? 0 : num;
}

// Get raw value from formatted input
function getRawValue(input) {
  return input.value.replace(/[^0-9.]/g, '');
}

// Initialize a single input
function initNumberFormat(input) {
  // Skip if already initialized
  if (input.dataset.formatInitialized) return;
  
  input.dataset.formatInitialized = 'true';
  
  // Remove inline handlers to avoid duplicates
  input.removeAttribute('oninput');
  input.removeAttribute('onblur');
  
  // Add event listeners
  input.addEventListener('input', function() {
    formatNumberInput(this);
  });
  
  input.addEventListener('blur', function() {
    formatOnBlur(this);
  });
  
  // Add helper methods
  Object.defineProperty(input, 'parsedValue', {
    get: function() { return parseFormattedNumber(this.value); },
    enumerable: false
  });
  
  Object.defineProperty(input, 'rawValue', {
    get: function() { return getRawValue(this); },
    enumerable: false
  });
}

// Initialize all inputs with data-format-number attribute
function initAllNumberFormats() {
  document.querySelectorAll('[data-format-number]').forEach(input => {
    initNumberFormat(input);
  });
}

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAllNumberFormats);
  } else {
    initAllNumberFormats();
  }
}

// Export for module usage (if needed)
if (typeof window !== 'undefined') {
  window.NumberFormat = {
    format: formatNumberInput,
    formatOnBlur: formatOnBlur,
    parse: parseFormattedNumber,
    getRaw: getRawValue,
    init: initNumberFormat,
    initAll: initAllNumberFormats
  };
}
