# Wasender Webhook Notes

تُحوَّل حالات `messages.update` الرقمية وفق توثيق Wasender إلى: `0` فشل، `1` انتظار، `2` تم الإرسال، `3` تم التسليم، `4` تمت القراءة، و`5` تم التشغيل. يعتمد النظام هذه القيم عند تحديث سجل الرسائل وعرض ملخص واتساب.

يوثق Wasender أن `message.sent` و`messages.update` و`session.status` أحداث webhook مستقلة، وأن التحقق من الطلب يتم بمطابقة رأس `X-Webhook-Signature` مع webhook secret المحفوظ على الخادم.

في حدث `messages.received`، يكون نص العميل في `data.messages.messageBody` أو `data.messages.message.conversation`، ورقمه المنظف في `data.messages.key.cleanedSenderPn`. لذلك يعتمد مسار متابعة الرضا هذه الحقول، ويتجاهل أي رسالة مرسلة من الحساب نفسه (`key.fromMe = true`).

المراجع: https://wasenderapi.com/api-docs/webhooks/webhook-message-update ، https://wasenderapi.com/help/messaging/using-webhooks ، https://wasenderapi.com/api-docs/webhooks/webhook-setup
