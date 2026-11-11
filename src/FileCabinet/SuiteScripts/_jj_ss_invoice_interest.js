/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 */
// /******************************************************************************
// ********
//  * Test Company
//  *
//  * ${OTP10744}: ${Develop and deploy a scheduled script (APPLYING INTEREST ON INVOICES OVERDUE BY 45 DAYS)}
//  *
//  *
//  ******************************************************************************
// ********
//  *
//  * Author: Jobin and Jismi IT Services
//  *
//  * Date Created : 11-November-2026
//  *
//  * Description : Develop and deploy a daily scheduled script to automatically apply a 5% penalty to invoices that remain unpaid after 45 days. Additionally, apply an ongoing 1.5% interest charge every 30 days thereafter until the balance is paid in full. Create a new 'Other Charges' 
//  * item named 'Order Penalty' and add it to the invoice to update the total payable amount.
//  *
//  * REVISION HISTORY
//  *
//  * @version 1.0 Test Company   : 11-November-2026 : Created the initial build by JJ0494
//  *
//  *
//  ******************************************************************************
// *********/
define(['N/search', 'N/record', 'N/runtime', 'N/format', 'N/log'],
    function (search, record, runtime, format, log) {

        const PENALTY_PERCENT = 5;
        const DAYS_BEFORE_PENALTY = 45;
        const MS_PER_DAY = 24 * 60 * 60 * 1000;
        const MIN_GOVERNANCE_LEFT = 200;

        function execute(scriptcontext) {

            try {
                let script = runtime.getCurrentScript();
                let PENALTY_ITEM_ID = 3679;
                let testCustomer = script.getParameter({ name: 'custscript_jj_pen_test_customer' });

                if (!PENALTY_ITEM_ID) {
                    throw new Error('Script parameter custscript_pen_item_id (Order Penalty item ID) is not set.');
                }

                // Today at midnight, so we count whole days
                let today = new Date();
                today.setHours(0, 0, 0, 0);

                // Invoices dated on or before this are at least 45 days old
                let cutoff = new Date(today.getTime() - DAYS_BEFORE_PENALTY * MS_PER_DAY);

                log.audit('START', 'Today: ' + today.toDateString() + ' | Cutoff: ' + cutoff.toDateString() +
                    ' | Item ID: ' + PENALTY_ITEM_ID + ' | Test customer: ' + (testCustomer || 'ALL'));

                let filters = [
                    ['mainline', 'is', 'T'],
                    'AND', ['status', 'anyof', 'CustInvc:A'],                       // Open Invoices
                    'AND', ['amountremaining', 'greaterthan', '0.00'],
                    'AND', ['custbody_jj_exclude_from_penalty', 'is', 'F'],
                    'AND', ['trandate', 'onorbefore', format.format({ value: cutoff, type: format.Type.DATE })]
                ];
                if (testCustomer) {
                    filters.push('AND', ['entity', 'anyof', testCustomer]);
                }

                let invoiceSearch = search.create({
                    type: search.Type.INVOICE,
                    filters: filters,
                    columns: [
                        'internalid',
                        'tranid',
                        'trandate',
                        'amountremaining',
                        'custbody_jj_penalty_applied',
                        'custbody_jj_penalty_applied_date'
                    ]
                });

                let found = 0, charged = 0, skipped = 0, failed = 0;

                invoiceSearch.run().each(function (result) {

                    // Stop safely if running out of governance units
                    if (script.getRemainingUsage() < MIN_GOVERNANCE_LEFT) {
                        log.audit('STOPPED EARLY', 'Low governance. Remaining invoices will be done in the next run.');
                        return false;
                    }

                    found++;
                    let invoiceId = result.getValue('internalid');
                    let invoiceNumber = result.getValue('tranid');

                    try {
                        let amountRemaining = parseFloat(result.getValue('amountremaining')) || 0;

                        let penaltyApplied =
                            result.getValue('custbody_jj_penalty_applied') === true ||
                            result.getValue('custbody_jj_penalty_applied') === 'T';

                        // Parse the invoice date properly (NetSuite returns it as text in the account's date format)
                        let invoiceDate = format.parse({
                            value: result.getValue('trandate'),
                            type: format.Type.DATE
                        });
                        invoiceDate.setHours(0, 0, 0, 0);

                        let daysOpen = Math.floor((today.getTime() - invoiceDate.getTime()) / MS_PER_DAY);

                        log.debug('Invoice ' + invoiceNumber,
                            'ID: ' + invoiceId + ' | Days open: ' + daysOpen +
                            ' | Amount remaining: ' + amountRemaining +
                            ' | Penalty applied: ' + penaltyApplied);

                        // Nothing to do?
                        if (penaltyApplied) {
                            skipped++;
                            log.debug('SKIPPED ' + invoiceNumber, 'Penalty already applied.');
                            return true;
                        }
                        if (daysOpen < DAYS_BEFORE_PENALTY) {
                            skipped++;
                            return true;
                        }

                        // Load the invoice (only when a charge is needed)
                        let invoiceRec = record.load({
                            type: record.Type.INVOICE,
                            id: invoiceId,
                            isDynamic: true
                        });

                        // Work out the base amount for the percentage:
                        // Amount Due minus any penalty lines already on the invoice
                        let penaltyLinesTotal = 0;
                        let lineCount = invoiceRec.getLineCount({ sublistId: 'item' });
                        for (let i = 0; i < lineCount; i++) {
                            let lineItem = invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                            if (String(lineItem) === String(PENALTY_ITEM_ID)) {
                                penaltyLinesTotal += Number(
                                    invoiceRec.getSublistValue({ sublistId: 'item', fieldId: 'amount', line: i })) || 0;
                            }
                        }
                        let base = roundCurrency(amountRemaining - penaltyLinesTotal);

                        if (base <= 0) {
                            skipped++;
                            log.audit('SKIPPED ' + invoiceNumber, 'Base amount is ' + base + '.');
                            return true;
                        }

                        // 5% penalty (once)
                        let penaltyAmount = roundCurrency(base * PENALTY_PERCENT / 100);

                        addChargeLine(invoiceRec, PENALTY_ITEM_ID, penaltyAmount,
                            PENALTY_PERCENT + '% late payment penalty - ' + daysOpen + ' days open');

                        invoiceRec.setValue({ fieldId: 'custbody_jj_penalty_applied', value: true });
                        invoiceRec.setValue({ fieldId: 'custbody_jj_penalty_applied_date', value: today });

                        log.audit('Penalty Applied', 'Invoice: ' + invoiceNumber + ' | ' +
                            PENALTY_PERCENT + '% of ' + base + ' = ' + penaltyAmount);

                        invoiceRec.save({
                            enableSourcing: true,
                            ignoreMandatoryFields: true
                        });

                        charged++;
                        log.audit('SAVED ' + invoiceNumber, 'Invoice ID ' + invoiceId + ' updated.');

                    } catch (e) {
                        failed++;
                        log.error({
                            title: 'Invoice Processing Error - ' + invoiceNumber + ' (ID ' + invoiceId + ')',
                            details: e.name + ': ' + e.message
                        });
                    }

                    return true;
                });

                log.audit('SUMMARY', 'Found: ' + found + ' | Charged: ' + charged +
                    ' | Skipped: ' + skipped + ' | Failed: ' + failed +
                    ' | Usage left: ' + script.getRemainingUsage());

            } catch (e) {
                log.error({ title: 'Scheduled Script Error', details: e.name + ': ' + e.message });
                throw e; // so the script shows as FAILED in the deployment status
            }
        }

        // Adds one 'Order Penalty' line to an invoice that is open in dynamic mode
        function addChargeLine(invoiceRec, itemId, amount, description) {
            invoiceRec.selectNewLine({ sublistId: 'item' });
            invoiceRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: itemId });
            invoiceRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: 1 });
            invoiceRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'price', value: -1 }); // Custom price level
            invoiceRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: amount });
            invoiceRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: description });
            invoiceRec.commitLine({ sublistId: 'item' });
        }

        function roundCurrency(amount) {
            return Math.round(amount * 100) / 100;
        }

        return {
            execute: execute
        };
    });