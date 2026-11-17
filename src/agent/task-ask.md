# Task: answer questions

Answer the questions below about the documents in `/in`. Choose your own approach and your own tools.

## Questions

{{QUESTIONS}}

## Output

Write two files. Then stop.

1. `/out/answer.md`: the answer, in the language of the questions. Be direct and complete. Give the values that the reader needs, with units. Add short context when it helps: limits, dates, anomalies, ambiguity. Use a short table when the answer has many values. If the documents do not answer a question, say so and say what you checked.
2. `/out/sources.json`: where the key facts come from, so that a reader can check them. It is an array. Each item is one of these:

```json
[
  { "doc": "contract.pdf", "page": 3, "quote": "exact text copied from the page" },
  { "doc": "data.xlsx", "sheet": "Sheet name", "range": "E41:P42", "values": ["<1", 15] },
  { "doc": "memo.docx", "quote": "exact text copied from the document" },
  { "doc": "data.csv", "quote": "exact text copied from the file" },
  { "doc": "report.pdf", "page": 2, "figure": true }
]
```

- Copy each quote exactly. Keep it short: one sentence or less.
- For a spreadsheet, `values` are the cell values that you used, as they are in the cells.
- Use `"figure": true` for a fact that `describe_figure` read from an image.

Before you stop, read each question again and compare it with your answer. If a question is not answered, look once more in the most likely place. Then stop, and say in the answer what is still missing or uncertain.
