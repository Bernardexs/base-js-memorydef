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