import {useEffect} from 'react';
/** Runs inside the R3F root after its initial suspended scene has committed. */
export default function SceneReadiness({onReady}:{onReady:()=>void}){useEffect(()=>onReady(),[onReady]);return null;}
