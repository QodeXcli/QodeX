# JSON-LD Schema Recipes

Copy-ready templates. Fill every `{{placeholder}}` with **real** values from the
page. Delete any block whose data you don't actually have — an omitted schema beats
a fabricated one. All blocks go inside `<script type="application/ld+json">…</script>`.
Combine multiple types with an `@graph` array under one script tag.

> Required fields are marked `// required`. Google's rich-result eligibility needs
> them; missing required fields = the schema is ignored (or flagged).

---

## Article / BlogPosting
```json
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "{{title, <=110 chars}}",           // required
  "description": "{{summary}}",
  "image": ["{{https://.../1200x630.jpg}}"],       // required for rich result
  "datePublished": "{{2026-01-15T08:00:00+03:30}}", // required
  "dateModified": "{{2026-06-03T10:00:00+03:30}}",
  "author": {
    "@type": "Person",
    "name": "{{Author Name}}",                      // required
    "url": "{{https://.../author-bio}}"
  },
  "publisher": {
    "@type": "Organization",
    "name": "{{Brand}}",
    "logo": { "@type": "ImageObject", "url": "{{https://.../logo.png}}" }
  },
  "mainEntityOfPage": { "@type": "WebPage", "@id": "{{canonical-url}}" }
}
```

## FAQPage — highest-leverage GEO block
Use for the People-Also-Ask gaps. Each answer must also appear visibly on the page.
```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "{{The exact question a user types}}",  // required
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "{{A direct, self-contained 2-3 sentence answer.}}"  // required
      }
    }
  ]
}
```

## Product (for e-commerce / brand pages)
Only include `review`/`aggregateRating` if the ratings are real and on-page.
```json
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "{{Product Name}}",                       // required
  "image": ["{{https://.../product.jpg}}"],
  "description": "{{...}}",
  "brand": { "@type": "Brand", "name": "{{Brand}}" },
  "sku": "{{SKU}}",
  "offers": {
    "@type": "Offer",
    "priceCurrency": "{{USD}}",                      // required if offers present
    "price": "{{19.99}}",                            // required if offers present
    "availability": "https://schema.org/InStock",
    "url": "{{product-url}}"
  }
}
```

## Organization (site-wide, in the homepage/layout)
```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "{{Brand}}",                              // required
  "url": "{{https://example.com}}",                 // required
  "logo": "{{https://.../logo.png}}",
  "sameAs": ["{{https://instagram.com/...}}", "{{https://x.com/...}}"]
}
```

## BreadcrumbList (helps both SERP display and AI navigation)
```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "{{Home}}", "item": "{{url}}" },
    { "@type": "ListItem", "position": 2, "name": "{{Category}}", "item": "{{url}}" }
  ]
}
```

## HowTo (for step-by-step / tutorial intent)
```json
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "{{How to ...}}",                          // required
  "step": [
    { "@type": "HowToStep", "name": "{{Step 1}}", "text": "{{...}}" }
  ]
}
```

## LocalBusiness (for logistics/physical presence, e.g. ChinPost)
```json
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "name": "{{Business}}",                            // required
  "address": {
    "@type": "PostalAddress",
    "addressCountry": "{{IR}}",
    "addressLocality": "{{City}}"
  },
  "url": "{{url}}",
  "telephone": "{{+98...}}"
}
```

---

## hreflang cluster (fa/en) — paste in `<head>` of BOTH language versions
```html
<link rel="alternate" hreflang="fa-IR" href="https://example.com/fa/page" />
<link rel="alternate" hreflang="en-US" href="https://example.com/en/page" />
<link rel="alternate" hreflang="x-default" href="https://example.com/en/page" />
```

## Minimal `llms.txt` (site root, plain markdown)
```markdown
# {{Brand}}
> {{One-line description of what the site/brand is.}}

## Key pages
- [{{Page title}}]({{url}}): {{what it covers}}
- [{{Page title}}]({{url}}): {{what it covers}}

## About
{{2-3 sentences of authoritative, citable context about the entity.}}
```
