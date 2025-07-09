import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { MetaProvider as Provider } from '@builderbot/provider-meta'
import dotenv from 'dotenv'
import axios from 'axios'
dotenv.config()

const PORT = process.env.PORT ?? 3008

export const provider = createProvider(Provider, {
  jwtToken: process.env.jwtToken,
  numberId: process.env.numberId,
  verifyToken: process.env.verifyToken,
  version: process.env.version
})

const afirmaciones = ['SI', 'SÍ', 'CLARO', 'DALE', 'LISTO', 'ACEPTO', 'VOY', 'DE UNA', 'OK']
const negaciones = ['NO', 'NO GRACIAS', 'NUNCA', 'NEGADO', 'AHORA NO', 'NO DESEARÍA', 'PASO']

const INACTIVITY_MINUTES = 1
const inactivityTimers = new Map()
const reminderCounts = new Map()
const PRE_ENCUESTA = -1 // paso especial para el mensaje inicial

function clearReminder(user, paso = null) {
  if (inactivityTimers.has(user)) {
    clearTimeout(inactivityTimers.get(user))
    inactivityTimers.delete(user)
  }
  if (paso !== null) {
    reminderCounts.delete(`${user}-${paso}`)
  }
}

function scheduleReminder(user, paso, state) {
  clearReminder(user)

  const key = `${user}-${paso}`
  const currentCount = reminderCounts.get(key) || 0
  if (currentCount >= 2) return // máximo 2 veces

  const timeoutId = setTimeout(async () => {
    const datos = await state.getMyState()
    if (!datos || datos.paso !== paso) return

    try {
      if (paso === PRE_ENCUESTA) {
        await provider.sendText(
          user,
          '👋 Hola, ¿aún te interesa participar en una breve encuesta? Responde *sí* o *no* para continuar.'
        )
      } else {
        await provider.sendText(
          user,
          `Tu opinión es muy valiosa para nosotros 🙏, ¿podrías ayudarnos respondiendo la pregunta ${paso + 1}?`
        )
      }
    } catch (e) {
      console.error('❌ Error al enviar recordatorio:', e.message)
    }

    reminderCounts.set(key, currentCount + 1)
    scheduleReminder(user, paso, state)
  }, INACTIVITY_MINUTES * 60 * 1000)

  inactivityTimers.set(user, timeoutId)
}

// Reemplaza esta sección en tu código:
.addAnswer(null, { capture: true }, async (ctx, { state, flowDynamic, gotoFlow }) => {
  console.log("🔍 Respuesta recibida, verificando estado...");
  clearReminder(ctx.from);

  const datos = await state.getMyState();
  console.log("📂 Datos del estado durante la respuesta:", datos);

  if (!datos || !datos.preguntas) {
    console.log(`❌ No hay preguntas cargadas para el usuario ${ctx.from}.`);
    return;
  }

  let { preguntas, respuestas, paso, despedida } = datos;
  const preguntaActual = preguntas[paso];
  const respuesta = ctx.body.trim();

  console.log(`📩 Respuesta del contacto ${ctx.from}: ${respuesta}`);

  if (paso >= preguntas.length) {
    console.log("✅ Ya completaste todas las preguntas. Finalizando encuesta.");
    await flowDynamic('❌ Ya completaste todas las preguntas. No necesitas continuar con el flujo.');
    return;
  }

  // Verificamos tipo de pregunta: RANGO o CONFIRMA
  if (preguntaActual.tipoRespuesta === 'RANGO') {
    const valor = parseInt(respuesta, 10);
    if (isNaN(valor) || valor < preguntaActual.rangoIni || valor > preguntaActual.rangoFin) {
      console.log(`❌ Respuesta incorrecta para RANGO. Esperado entre ${preguntaActual.rangoIni} y ${preguntaActual.rangoFin}.`);
      await flowDynamic(`❌ Por favor responde con un número entre ${preguntaActual.rangoIni} y ${preguntaActual.rangoFin}.`);
      return gotoFlow(encuestaFlow);
    }
  } else if (preguntaActual.tipoRespuesta === 'CONFIRMA') {
    const aceptadas = ['SI', 'NO', 'SÍ'];
    if (!aceptadas.includes(respuesta.toUpperCase())) {
      console.log(`❌ Respuesta incorrecta para CONFIRMA. Esperado "SI" o "NO".`);
      await flowDynamic('❌ Responde solo con "SI" o "NO".');
      return gotoFlow(encuestaFlow);
    }
  }

  respuestas.push(respuesta);
  paso++;

  console.log(`📊 Paso actual: ${paso} de ${preguntas.length}`);

  // Verificamos si hemos llegado al final de la encuesta
  if (paso >= preguntas.length) {
    console.log("✅ Encuesta completada, guardando respuestas...");
    await state.update({
      preguntas: null,
      respuestas: null,
      paso: null,
      encuestaTerminada: true
    });

    const resumen = respuestas.map((r, i) => `❓ ${preguntas[i].pregunta}\n📝 ${r}`).join('\n\n');

    const payload = respuestas.map((r, i) => ({
      idContacto: ctx.from,
      idEncuesta: preguntas[i].idEncuesta,
      idEmpresa: preguntas[i].idEmpresa,
      pregunta: preguntas[i].pregunta,
      respuesta: r,
      tipo: preguntas[i].tipoRespuesta,
      idPregunta: preguntas[i].idPregunta
    }));

    try {
      await axios.post('http://localhost:7003/guardar-respuestas', payload);
      console.log('✅ Respuestas enviadas exitosamente.');
      await flowDynamic('📩 Tus respuestas fueron enviadas exitosamente.');
    } catch (e) {
      console.error('⚠ Error al guardar respuestas:', e.message);
      await flowDynamic('⚠ Hubo un problema al guardar tus respuestas.');
    }

    await flowDynamic(despedida);
    await flowDynamic(`✅ Tus respuestas:\n\n${resumen}`);
    
    // ✅ AQUÍ ESTÁ LA CORRECCIÓN: Agregar return para evitar continuar
    return; // ← ESTO EVITA QUE CONTINÚE EL FLUJO
  }

  // Si no hemos llegado al final, mostramos la siguiente pregunta
  const siguiente = preguntas[paso];
  let mensaje = `${paso + 1}⃣ ${siguiente.pregunta}`;

  if (siguiente.textoIni && siguiente.tipoRespuesta === 'RANGO') {
    mensaje += `\n*Califica del rango ${siguiente.rangoIni} al ${siguiente.rangoFin}*`;
    mensaje += '\n' + siguiente.textoIni.split('=').map(s => s.replace('-', ' - ').trim()).join('\n');
  } else if (siguiente.textoIni) {
    mensaje += '\n' + siguiente.textoIni.split('=').map(s => s.replace('-', ' - ').trim()).join('\n');
  }

  console.log(`📲 Enviando siguiente mensaje: ${mensaje}`);
  await state.update({ preguntas, respuestas, paso, despedida });
  await flowDynamic(mensaje);
  scheduleReminder(ctx.from, paso, state);
  return gotoFlow(encuestaFlow);
});

const negacionFlow = addKeyword(negaciones).addAction(async (ctx, { flowDynamic, state }) => {
  await state.update({ finalizada: true })
  await flowDynamic('✅ Gracias por tu tiempo. Si deseas participar en otro momento, estaré disponible.')
})

const defaultFlow = addKeyword(EVENTS.WELCOME).addAction(async (ctx, { flowDynamic, state }) => {
  if (!ctx.body || ctx.body.trim() === '') return

  const yaFinalizada = await state.get('finalizada')
  if (yaFinalizada) {
    await flowDynamic('✅ Ya has completado la encuesta. ¡Gracias por tu participación!')
    return
  }

  const { data } = await axios.get('http://localhost:7003/datos-encuesta')
  const { contactos } = data
  const usuario = contactos.find(u => u.num === ctx.from)

  if (!usuario) {
    await flowDynamic('❌ No se encontró una encuesta asignada para ti.')
    return
  }

  await state.update({ paso: PRE_ENCUESTA })
  await flowDynamic('👋 ¡Hola! ¿Deseas participar en una breve encuesta? Responde *sí* o *no* para continuar.')
  scheduleReminder(ctx.from, PRE_ENCUESTA, state)
})
.addAnswer(null, { capture: true }, async (ctx, { gotoFlow }) => {
  const respuesta = ctx.body.trim().toUpperCase()
  if (afirmaciones.includes(respuesta)) {
    return gotoFlow(encuestaFlow)
  } else if (negaciones.includes(respuesta)) {
    return gotoFlow(negacionFlow)
  }
})

const main = async () => {
  const adapterFlow = createFlow([encuestaFlow, negacionFlow, defaultFlow])
  const adapterDB = new Database()

  const { httpServer } = await createBot({
    flow: adapterFlow,
    provider,
    database: adapterDB
  })

  provider.server.get('/v1/prueba', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('✅ Ruta activa: /v1/prueba (GET)')
  })

  httpServer(+PORT)
}

main()
