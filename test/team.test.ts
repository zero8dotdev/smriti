import { isValidCategory } from './categorize/schema';

// Test cases for tag parsing
const tagTests = [
  {
    input: 'tags: ["project", "project/dependency", "decision/tooling"]',
    expected: ['project', 'project/dependency', 'decision/tooling']
  },
  {
    input: 'tags: ["a", "b/c", "d"]',
    expected: ['a', 'b/c', 'd']
  },
  {
    input: 'category: project\ntags: ["a", "b"]',
    expected: ['a', 'b']
  }
];

// Test for backward compatibility
const compatTestCases = [
  {
    input: 'category: project',
    expected: ['project']
  },
  {
    input: 'tags: ["invalid"]',
    expected: []
  }
];

// Roundtrip test
const roundtripTestCases = [
  {
    input: 'category: project\ntags: ["a", "b/c"]',
    expected: ['a', 'b/c']
  }
];

// Run tests
for (const test of tagTests) {
  const parsed = parseFrontmatter(test.input);
  console.assert(JSON.stringify(parsed.tags) === JSON.stringify(test.expected), `
    Test failed: Input ${test.input} expected ${test.expected} but got ${parsed.tags}`);
}

for (const test of compatTestCases) {
  const parsed = parseFrontmatter(test.input);
  console.assert(JSON.stringify(parsed.tags) === JSON.stringify(test.expected), `
    Compatibility test failed: Input ${test.input} expected ${test.expected} but got ${parsed.tags}`);
}

for (const test of roundtripTestCases) {
  const parsed = parseFrontmatter(test.input);
  console.assert(JSON.stringify(parsed.tags) === JSON.stringify(test.expected), `
    Roundtrip test failed: Input ${test.input} expected ${test.expected} but got ${parsed.tags}`);
}