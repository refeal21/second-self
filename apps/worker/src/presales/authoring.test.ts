import { expect, it } from 'vitest';
import { buildPairedAuthoringPrompt, parsePairedAuthoringResult } from './authoring.js';
import { sourceAnalysis, scenarioOutline, scenarioDetails } from './fixtures.test-support.js';
import { PRESALES_SKILL_METADATA } from './planning.js';

const context = () => ({ name:'Synthetic copy', brief:'Saved goal', context:{taskBrief:'Saved brief',sourceInstructions:{'source-a':'facts'},outlineRequirements:'Two sections'}, preferences:{}, palette:{revision:1,locked:false,profile:{primaryColor:'#112233',backgroundColor:'#ffffff',textColor:'#000000',accentColors:[],instructions:'saved palette',template:null}}, skill:PRESALES_SKILL_METADATA, sources:[{original:{id:'source-a',fileName:'synthetic.txt'},asset:{relativePath:'copy/assets/source.txt'}}], analysis:{original:{requestId:'analysis-origin',sha256:'a'.repeat(64),output:sourceAnalysis()},asset:{relativePath:'copy/assets/analysis.json'}}, approvedOutline:scenarioOutline() });

it('builds the real paired prompt from copied locators and returns full strictly mapped envelopes', () => {
  const prompt = buildPairedAuthoringPrompt('details',context());
  expect(prompt).toContain('copy/assets/analysis.json');
  expect(prompt).toContain('copy/assets/source.txt');
  expect(prompt).toContain('Saved brief');
  expect(prompt).toContain('DetailsEnvelope');
  expect(prompt).toContain('approvedPresalesPlan');
  expect(prompt).toContain(PRESALES_SKILL_METADATA.sha256);
  const parsed = parsePairedAuthoringResult('details',JSON.stringify(scenarioDetails()),context());
  expect(parsed).toEqual(scenarioDetails());
  expect(() => parsePairedAuthoringResult('details',JSON.stringify(scenarioDetails().specs),context())).toThrow();
  const wrong = scenarioDetails(); wrong.designs[0]!.slideId = 'wrong-page';
  expect(() => parsePairedAuthoringResult('details',JSON.stringify(wrong),context())).toThrow();
});

it('requires the actual complete outline pair for details and refuses extra approval fields', () => {
  expect(() => buildPairedAuthoringPrompt('details',{...context(),approvedOutline:null})).toThrow();
  expect(() => parsePairedAuthoringResult('outline',JSON.stringify({...scenarioOutline(),approved:true}),context())).toThrow();
});
