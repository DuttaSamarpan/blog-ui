import './App.css';
import React from 'react';
import { useState } from 'react';

function MyButton({count, onClick}) {
  return (
    <button onClick={onClick}>Clicked {count} times</button>
  )
}

function App() {
  const [count, setCount] = useState(0)

  function handleClick(){
    setCount(count+1)
  }

  return(
    <div>
      <MyButton count={count} onClick={handleClick}/>
      <MyButton count={count} onClick={handleClick}/>
    </div>
  )
}

export default App;
