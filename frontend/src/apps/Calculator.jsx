import React, { useState } from 'react';

export default function Calculator() {
  const [display, setDisplay] = useState('0');
  const [prevValue, setPrevValue] = useState(null);
  const [operator, setOperator] = useState(null);
  const [waitingForOperand, setWaitingForOperand] = useState(false);

  function inputDigit(digit) {
    if (waitingForOperand) {
      setDisplay(String(digit));
      setWaitingForOperand(false);
    } else {
      setDisplay(display === '0' ? String(digit) : display + digit);
    }
  }

  function inputDecimal() {
    if (waitingForOperand) {
      setDisplay('0.');
      setWaitingForOperand(false);
      return;
    }
    if (!display.includes('.')) {
      setDisplay(display + '.');
    }
  }

  function clear() {
    setDisplay('0');
    setPrevValue(null);
    setOperator(null);
    setWaitingForOperand(false);
  }

  function performOperation(nextOperator) {
    const inputValue = parseFloat(display);

    if (prevValue === null) {
      setPrevValue(inputValue);
    } else if (operator && operator !== '=') {
      const currentValue = prevValue || 0;
      let result = 0;
      switch (operator) {
        case '+': result = currentValue + inputValue; break;
        case '-': result = currentValue - inputValue; break;
        case '*': result = currentValue * inputValue; break;
        case '/': result = inputValue !== 0 ? currentValue / inputValue : 'Error'; break;
        default: break;
      }
      setPrevValue(typeof result === 'number' ? parseFloat(result.toFixed(10)) : result);
      setDisplay(String(typeof result === 'number' ? parseFloat(result.toFixed(10)) : result));
    }

    if (nextOperator === '=') {
      setOperator(null);
      setPrevValue(null);
      setWaitingForOperand(true);
    } else {
      setWaitingForOperand(true);
      setOperator(nextOperator);
    }
  }

  const buttons = [
    ['C', '±', '%', '/'],
    ['7', '8', '9', '*'],
    ['4', '5', '6', '-'],
    ['1', '2', '3', '+'],
    ['0', '.', '=']
  ];

  return (
    <div style={{ maxWidth: '320px', margin: '20px auto' }}>
      <div style={{
        background: '#1a1d27', color: 'white', padding: '20px', borderRadius: '12px',
        marginBottom: '16px', textAlign: 'right', fontSize: '32px', minHeight: '80px',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end'
      }}>
        {display}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
        {buttons.flat().map((btn) => {
          const isOperator = ['/', '*', '-', '+', '='].includes(btn);
          const isSpecial = ['C', '±', '%'].includes(btn);
          return (
            <button key={btn} onClick={() => {
              if (btn === 'C') clear();
              else if (btn === '±') setDisplay(String(-parseFloat(display)));
              else if (btn === '%') setDisplay(String(parseFloat(display) / 100));
              else if (btn === '=') performOperation('=');
              else if (['/', '*', '-', '+'].includes(btn)) performOperation(btn);
              else if (btn === '.') inputDecimal();
              else inputDigit(parseInt(btn));
            }} style={{
              padding: '20px', fontSize: '18px', fontWeight: 600, border: 'none',
              borderRadius: '8px', cursor: 'pointer',
              background: isOperator ? '#6c5ce7' : (isSpecial ? '#e2e4ea' : '#f0f1f3'),
              color: isOperator ? 'white' : '#1a1d27'
            }}>
              {btn}
            </button>
          );
        })}
      </div>
    </div>
  );
}
