---
name: code-review
description: Review code for quality issues, bugs, and style violations. Use when user asks to review code.
---

# Code Review Skill

## Steps
1. Use `run_read` to read the target file(s)
2. Analyze for:
   - Unused variables/imports
   - Missing error handling
   - Security vulnerabilities
   - Style inconsistencies
   - Logic errors or edge cases
3. Report findings with file:line references

## Output Format
For each finding:
- Severity: Critical / Warning / Info
- Location: file:line
- Issue: description of the problem
- Suggestion: how to fix it

## End with
- Summary: total findings by severity
- Overall assessment of code quality
