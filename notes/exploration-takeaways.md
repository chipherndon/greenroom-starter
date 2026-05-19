# Exploratation Takeaways

After conducting a thorough exploration of the brief, transcripts, dispute thread, frontend, backend, and querying the db to understand the data model/what data is actually getting stored. I have a few major takeaways.

1. Versus deals are the most obvious lacking piece of the product, and critical to fix immediately.
2. Deal ambiguity (especially regarding recoups) is a lesser understood problem by Greenroom management, but is a loss leader for our customers and also critical to fix.
3. Expense management is a huge pain point for out customers, but a highly distributed problem that requires a solution beyond the scope of what our slice should handle. Should be addeed to roadmap
4. Observability and shown work is a requirement for settlements to be trusted.

The recurring theme here is settlement is present at every stage of the operational lifecycle. Our current product treats it more as a post-show function. My focus will be on implementing a solution that sets a strong foundation from the deal inception by handling industry standard deal types (1) and standardizing recoup arrangements to prevent ambiguity leading to disputes (2). I see these as two tightly coupled slices as they both stem from the same true problem. Our product does not handle strong definitions of the industry standard deal types and arrangements from inception, leading to the large array of downstream issues observed in the field.

## Brief

The entire brief points strongly at versus deals as the most critically lacking piece of the product, to which I strongly agree. It also points at expense collection and deal ambiguity as major pain points. From the brief alone these seem to be the three most important problems to solve. Priority and degree of relatedness from the brief alone was unclear.

## Transcripts

The transcripts provided a rich source of insight into the problems indicated in the brief. They revealed that ambiguity of deal terms is a bigger problem that initially indicated, our client once suffered an $80k loss in gross revenue from a bad settlement resulting in a lost customer. In addition to that it confirmed the software is seriously lacking in the ability to handle deals that are not flat guarantees (which was known), and expenses take up a huge proportion of time when handling settlements.

Most importantly they revealed that observability and shown work is the key to success in settlement, and thus our product itself. Our solution should have clear preview of the deal prior to signing, and have a nice display showing work at the time of settlement. This was indicated as a requirement by all those interviewed. This is a major indicator that our problems of ambiguity and versus deal handling are actually coupled under the umbrella of our product's core problem, settlement is treated as post show concern. When in reality, **settlement is present during the entire operational lifecycle.** Something that the [Dispute Thread](data/dispute-thread.md) showcases nicely.

## Backend

The codebase is undeveloped in the deal math engine, it calls out this issue in [dealMath.ts](/lib/dealMath.ts). That file also calls out tier_ratchet which currently has a skeleton but no implementation. **URGENT**: bonusesJson can cause silent parse errors.

Additionally, our data model is inflexible towards Vs deals. Real thought needs to be put into how to modify this system to be more dynamic, while maintaining the integrity of the data model and current simplistic system.

Overall, the backend was clearly punted early on in development, it's bones aren't bad but it needs to be fleshed out (this was expected, as literally all documentation and the entire brief points here).

### Data Observations

* Ambiguity is a recurrent issue in deals. Reading through the deal_notes_freetext field identifies several cases where the deal is ambiguous from my perspective. **We should be offering a way to reduce ambiguity in the terms.**
* bonusesJson is a field that can handle many different types of bonuses, good for it's flexibility but requires better validation and error handling. *Need to ensure maintained backwards compatibility.*
* dealType is vs, percentage_of_gross, percentage_of_net, and door.
* **IMPORTANT**: Deals can be modified and current model does not allow for modification, users update free text in place of modifying structure fields.

## Frontend

Our frontend has major UX issues. The `/shows` page is difficult to explore, sort and fitler should be implemented for better experience (command exists but is not indicated anywhere). The list left side indicators are non-descriptive, deal text is not informative enough to justify its presence, and dispute status is not always correct. Top-line stats are done well, though I think a chart would be better to show the trends rather than nets.

`shows/[id]` has a nice header of top level stats, but the following body is messy and hard to view. In deals bonuses and escalators need to be handled in a more robust way. Refactor required for most of the deal card. Expenses card doesn't handle absorbed by venue.

`shows/[id]/settle` is ready to start handling settlement as lifecycle style system. It's missing lots of features but has good bones and will be the base for where our slice majorly effects thus interface.