```text
  ,_,
 (O,O)    PR-Owl Review
 (   )    REQUEST CHANGES
 -"-"-    rb-20261016-save
```
**Summary:** Adds saving; one bug left.

- **[HIGH]** Saving twice loses the first write · `src/save.js:42`

<details>
<summary>📄 prowl-review-rb-20261016-save-api-12.md: the full review, for whoever fixes these (copy it into your coding agent)</summary>

````markdown
# PR-Owl Review: acme/api#12 — Add saving

## Findings

### F-01 [HIGH] Saving twice loses the first write

**Code:**

```js
save(a); save(b);
```

## Parked

- F-02 No CI pipeline runs these tests: a person creates the pipeline · https://github.com/acme/api/pull/12#discussion_r1005
````

Continued in part 2: https://github.com/acme/api/pull/12#issuecomment-9
</details>
