/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 */
// /******************************************************************************
//  *******
//  * OTP TASK
//  *
//  * ${OTP10744}: ${Develop and deploy a scheduled script (APPLYING INTEREST ON INVOICES OVERDUE BY 45 DAYS)}
//  *
//  *
//  ******************************************************************************
//  *******
//  *
//  * Author: Jobin and Jismi IT Services
//  *
//  * Date Created : 11-November-2026
//  *
//  * Description : This script is for an automated invoice penalty management system that applies penalty and interest charges to unpaid invoices once they become overdue. A daily scheduled script will identify invoices that remain unpaid 
//  * for more than 45 days and automatically add a 5% penalty using the "Order Penalty" item. Thereafter, for every additional 30 days the invoice remains unpaid, an extra 1.5% interest charge will be applied and added to the invoice through 
//  * the same penalty item, ensuring that invoice balances accurately reflect all overdue charges.
//  *
//  * REVISION HISTORY
//  *
//  * @version 1.0  OTP TASK : 11-November-2026 : Created the initial build by JJ0494
//  *
//  *
//  ******************************************************************************
// *********/

define(['N/search', 'N/record', 'N/format', 'N/runtime', 'N/log'],
    function (search, record, format, runtime, log) {

        // Constants Configuration
        let PENALTY_ITEM_ID = 3679;
        let INITIAL_PENALTY_DAYS = 45;
        let INTEREST_INTERVAL_DAYS = 30;
        let INITIAL_PENALTY_RATE = 0.05;     // 5%
        let RECURRING_INTEREST_RATE = 0.015; // 1.5%

        let MAX_INVOICES = 50;      // TEST: stop after this many invoices are charged (0 = no limit)
        let GOVERNANCE_FLOOR = 200; // stop when fewer than this many usage units are left

        let FIELDS = {
            APPLIED: 'custbody_jj_penalty_applied',
            APPLIED_DATE: 'custbody_jj_penalty_applied_date',
            CYCLES: 'custbody_jj_interest_cycles_applied',
            LAST_INTEREST: 'custbody_jj_last_interest_date',
            EXCLUDE: 'custbody_jj_exclude_from_penalty'
        };

        let DAY_MS = 1000 * 60 * 60 * 24;

        /**
         * Finds the open accounting periods. An invoice can only be edited
         * when its posting period is open.
         */
        function getOpenPeriodIds() {
            let baseFilters = [
                ['isquarter', 'is', 'F'], 'AND',
                ['isyear', 'is', 'F'], 'AND',
                ['closed', 'is', 'F']
            ];
            let lockFilters = [
                'AND', ['alllocked', 'is', 'F'],
                'AND', ['arlocked', 'is', 'F']
            ];

            function runPeriodSearch(filters) {
                let periods = [];
                search.create({
                    type: search.Type.ACCOUNTING_PERIOD,
                    filters: filters,
                    columns: ['periodname']
                }).run().each(function (r) {
                    periods.push({ id: r.id, name: r.getValue('periodname') });
                    return true;
                });
                return periods;
            }

            var periods;
            try {
                periods = runPeriodSearch(baseFilters.concat(lockFilters));
            } catch (e) {
                log.error('Open period search with lock filters failed',
                    e.message + ' - falling back to not-closed periods only');
                periods = runPeriodSearch(baseFilters);
            }

            log.audit('Open accounting periods',
                periods.length + ' found: ' + periods.map(function (p) {
                    return p.name + ' (id ' + p.id + ')';
                }).join(', '));

            return periods.map(function (p) {
                return p.id;
            });
        }

        /**
         * Turns common NetSuite save errors into a readable hint for the log.
         */
        function explainError(message) {
            let m = String(message || '');
            if (m.indexOf('is not valid for item') > -1) {
                return 'HINT: an existing line item is not available to the invoice subsidiary. Fix the item\'s Subsidiary list, or tick "Exclude from penalty" on this invoice.';
            }
            if (m.indexOf('discount item') > -1) {
                return 'HINT: the invoice/customer has a discount but no discount item. Fix the invoice, or tick "Exclude from penalty".';
            }
            if (m.indexOf('VALID_PRD_REQD') > -1 || m.indexOf('tax period') > -1) {
                return 'HINT: the invoice posting period is closed.';
            }
            if (m.indexOf('TRANS_UNBALNCD') > -1) {
                return 'HINT: the invoice is out of balance (check currency / rounding).';
            }
            return '';
        }

        /**
         * Logs a long list in parts, so each log entry stays under NetSuite's log size limit.
         */
        function logList(title, items) {
            if (!items.length) {
                log.audit(title, 'No invoices were charged in this run.');
                return;
            }
            let MAX_CHARS = 3000;
            let part = 1;
            let current = [];
            let currentLength = 0;

            for (let i = 0; i < items.length; i++) {
                if (currentLength + items[i].length > MAX_CHARS && current.length) {
                    log.audit(title + ' (part ' + part + ')', current.join('\n'));
                    part++;
                    current = [];
                    currentLength = 0;
                }
                current.push(items[i]);
                currentLength += items[i].length + 1;
            }

            log.audit(part > 1 ? title + ' (part ' + part + ')' : title, current.join('\n'));
        }

        /**
         * Main execution entry point for the Scheduled Script.
         */
        function execute(context) {
            let script = runtime.getCurrentScript();
            let today = new Date();
            today.setHours(0, 0, 0, 0);
            let todayStr = format.format({ value: today, type: format.Type.DATE });

            log.audit('Script started',
                'Today: ' + todayStr +
                ' | Penalty ' + (INITIAL_PENALTY_RATE * 100) + '% after ' + INITIAL_PENALTY_DAYS + ' days' +
                ' | Interest ' + (RECURRING_INTEREST_RATE * 100) + '% every ' + INTEREST_INTERVAL_DAYS + ' days' +
                ' | Item id ' + PENALTY_ITEM_ID +
                ' | Max invoices this run: ' + (MAX_INVOICES || 'no limit'));

            let openPeriodIds = getOpenPeriodIds();
            if (!openPeriodIds.length) {
                log.audit('Script finished', 'No open accounting periods found. Nothing to do.');
                return;
            }

            // Only invoices created 45+ days ago can ever be charged
            let cutoff = new Date(today.getTime() - INITIAL_PENALTY_DAYS * DAY_MS);
            let cutoffStr = format.format({ value: cutoff, type: format.Type.DATE });
            log.debug('Search filter', 'Created on or before ' + cutoffStr + ' and posted in an open period');

            // Search Open Invoices not excluded from penalties
            let invoiceSearch = search.create({
                type: search.Type.INVOICE,
                filters: [
                    ['mainline', 'is', 'T'],
                    'AND',
                    ['status', 'anyof', 'CustInvc:A'],
                    'AND',
                    ['amountremaining', 'greaterthan', '0'],
                    'AND',
                    [FIELDS.EXCLUDE, 'is', 'F'],
                    'AND',
                    ['trandate', 'onorafter', '6/1/2026']
                ],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'tranid' }),
                    search.createColumn({ name: 'datecreated', sort: search.Sort.ASC }),
                    search.createColumn({ name: 'amountremaining' }),
                    search.createColumn({ name: FIELDS.APPLIED }),
                    search.createColumn({ name: FIELDS.CYCLES })
                ]
            });

            let counts = { found: 0, penalty: 0, interest: 0, skipped: 0, errors: 0 };
            let failedInvoices = [];
            let succeededInvoices = [];
            let stopReason = 'all invoices processed';

            try {
                invoiceSearch.run().each(function (result) {
                    counts.found++;

                    // TEST LIMIT
                    if (MAX_INVOICES > 0 && (counts.penalty + counts.interest) >= MAX_INVOICES) {
                        stopReason = 'test limit of ' + MAX_INVOICES + ' charged invoices reached';
                        return false;
                    }
                    // GOVERNANCE LIMIT
                    if (script.getRemainingUsage() < GOVERNANCE_FLOOR) {
                        stopReason = 'low governance units (' + script.getRemainingUsage() + ' left), next run will continue';
                        return false;
                    }

                    let invoiceId = result.getValue({ name: 'internalid' });
                    let tranId = result.getValue({ name: 'tranid' });
                    let dateCreatedRaw = result.getValue({ name: 'datecreated' });
                    let amountDue = parseFloat(result.getValue({ name: 'amountremaining' })) || 0;

                    let isPenaltyApplied = result.getValue({ name: FIELDS.APPLIED }) === true || result.getValue({ name: FIELDS.APPLIED }) === 'T';
                    let cyclesApplied = parseInt(result.getValue({ name: FIELDS.CYCLES }), 10) || 0;

                    try {
                        // Calculate exact days since creation (date part only)
                        let createdDate = format.parse({ value: String(dateCreatedRaw).split(' ')[0], type: format.Type.DATE });
                        createdDate.setHours(0, 0, 0, 0);

                        let diffTime = today.getTime() - createdDate.getTime();
                        let daysOpen = Math.floor(diffTime / DAY_MS);

                        log.debug('Invoice ' + tranId + ' (ID: ' + invoiceId + ') - checked',
                            'Created: ' + format.format({ value: createdDate, type: format.Type.DATE }) +
                            ' | Days open: ' + daysOpen +
                            ' | Amount due: ' + amountDue +
                            ' | Penalty applied: ' + isPenaltyApplied +
                            ' | Cycles applied: ' + cyclesApplied);

                        // Skip if under 45 days
                        if (daysOpen < INITIAL_PENALTY_DAYS) {
                            counts.skipped++;
                            return true;
                        }

                        // Case 1: Initial 5% Penalty has not been applied yet (Day 45+)
                        if (!isPenaltyApplied) {
                            let penaltyAmount = parseFloat((amountDue * INITIAL_PENALTY_RATE).toFixed(2));
                            if (penaltyAmount > 0) {
                                let penaltyDescription = '5% Late Payment Penalty (' + daysOpen + ' Days Overdue) - Applied on ' + todayStr;
                                updateInvoiceWithCharge({
                                    invoiceId: invoiceId,
                                    tranId: tranId,
                                    amount: penaltyAmount,
                                    description: penaltyDescription,
                                    today: today,
                                    isInitialPenalty: true,
                                    newCycleCount: cyclesApplied
                                });
                                counts.penalty++;
                                succeededInvoices.push('Invoice ' + tranId + ' (ID: ' + invoiceId + ') - Penalty ' + penaltyAmount);
                            } else {
                                counts.skipped++;
                            }
                        }
                        // Case 2: Initial penalty already applied; check if a new 30-day interest cycle is due
                        else {
                            let totalEligibleCycles = Math.floor((daysOpen - INITIAL_PENALTY_DAYS) / INTEREST_INTERVAL_DAYS);

                            log.debug('Invoice ' + tranId + ' (ID: ' + invoiceId + ') - interest cycles',
                                'Eligible cycles: ' + totalEligibleCycles + ' | Already applied: ' + cyclesApplied);

                            if (totalEligibleCycles > cyclesApplied) {
                                let newCycleNumber = cyclesApplied + 1;
                                let interestAmount = parseFloat((amountDue * RECURRING_INTEREST_RATE).toFixed(2));

                                if (interestAmount > 0) {
                                    let interestDescription = '1.5% Monthly Late Interest - Cycle #' + newCycleNumber +
                                        ' (' + daysOpen + ' Days Overdue) - Applied on ' + todayStr;
                                    updateInvoiceWithCharge({
                                        invoiceId: invoiceId,
                                        tranId: tranId,
                                        amount: interestAmount,
                                        description: interestDescription,
                                        today: today,
                                        isInitialPenalty: false,
                                        newCycleCount: newCycleNumber
                                    });
                                    counts.interest++;
                                    succeededInvoices.push('Invoice ' + tranId + ' (ID: ' + invoiceId + ') - Interest cycle #' + newCycleNumber + ' ' + interestAmount);
                                } else {
                                    counts.skipped++;
                                }
                            } else {
                                counts.skipped++;
                            }
                        }

                    } catch (e) {
                        counts.errors++;
                        failedInvoices.push(tranId);
                        log.error('Error Processing Invoice ' + tranId + ' (ID: ' + invoiceId + ')',
                            e.message + ' ' + explainError(e.message));
                    }

                    return true;
                });
            } catch (fatalError) {
                // unexpected error (for example governance/usage limit): log it and still print the summary
                stopReason = 'unexpected error: ' + fatalError.name + ' - ' + fatalError.message;
                log.error('Script stopped by an unexpected error', fatalError.name + ': ' + fatalError.message);
            } finally {
                // Full list of invoices that were charged successfully (always printed)
                logList('Invoices charged successfully (' + succeededInvoices.length + ')', succeededInvoices);
            }

            log.audit('Script finished',
                'Stopped because: ' + stopReason +
                ' | Invoices read: ' + counts.found +
                ' | Penalties added: ' + counts.penalty +
                ' | Interest added: ' + counts.interest +
                ' | Skipped: ' + counts.skipped +
                ' | Errors: ' + counts.errors +
                ' | Governance units left: ' + script.getRemainingUsage());

            if (failedInvoices.length) {
                log.error('Invoices that failed', failedInvoices.join(', '));
            }
        }

        /**
         * Loads the invoice, appends the Order Penalty line item (ID 3679), and updates tracking body fields.
         */
        function updateInvoiceWithCharge(params) {
            let invoiceId = params.invoiceId;
            let tranId = params.tranId;
            let amount = params.amount;
            let description = params.description;
            let today = params.today;
            let isInitialPenalty = params.isInitialPenalty;
            let newCycleCount = params.newCycleCount;

            let invRecord = record.load({
                type: record.Type.INVOICE,
                id: invoiceId,
                isDynamic: true
            });

            // Add Order Penalty line item
            invRecord.selectNewLine({ sublistId: 'item' });
            invRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: PENALTY_ITEM_ID });
            invRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: 1 });
            invRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: amount });
            invRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'amount', value: amount });
            invRecord.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: description });
            invRecord.commitLine({ sublistId: 'item' });

            // Update Custom Tracking Fields
            if (isInitialPenalty) {
                invRecord.setValue({ fieldId: FIELDS.APPLIED, value: true });
                invRecord.setValue({ fieldId: FIELDS.APPLIED_DATE, value: today });
            } else {
                invRecord.setValue({ fieldId: FIELDS.CYCLES, value: newCycleCount });
                invRecord.setValue({ fieldId: FIELDS.LAST_INTEREST, value: today });
            }

            invRecord.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.audit('Charge Applied',
                'Invoice ' + tranId + ' (ID: ' + invoiceId + ') updated with ' + amount + ' | ' + description);
        }

        return {
            execute: execute
        };
    });